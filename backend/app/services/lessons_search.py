"""
Lessons Learned Search Service
- SDC TXT parser
- Document classifier (MCLASS/DCLASS → category 1.1~6.0)
- Azure AI Search index management (lessons-learned-index)
- Hybrid search (keyword + vector)
- Category facets
"""

import logging
import re
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import List, Dict, Optional, Tuple

from openai import AzureOpenAI
from azure.core.credentials import AzureKeyCredential
from azure.search.documents import SearchClient
from azure.search.documents.indexes import SearchIndexClient
from azure.search.documents.indexes.models import (
    SearchIndex,
    SimpleField,
    SearchableField,
    SearchField,
    SearchFieldDataType,
    VectorSearch,
    HnswAlgorithmConfiguration,
    VectorSearchProfile,
)
from azure.search.documents.models import VectorizedQuery

from app.core.config import settings

logger = logging.getLogger(__name__)

INDEX_NAME = "lessons-learned-index"

# ──────────────────────────────────────────────
# SDC TXT Parser
# ──────────────────────────────────────────────

# Tags that are single-line key-value
_SINGLE_TAGS = {
    'DOCID', 'DATE', 'FILE_SEQ', 'FILE_ID', 'HQ', 'PJT_NM', 'PJT_CD',
    'MCLASS', 'DCLASS', 'ICLASS', 'OUCM_NM', 'TAG', 'FILE_NM', 'CD_TYPE',
    'FILE_PATH', 'OCR_FILE_PATH', 'EXTENSION', 'REG_DATE', 'IDX_FLAG',
    'CREATOR_ID', 'CREATOR_NAME', 'CREATED_DATE', 'FILE_CONTENT_SIZE',
    'SECURED_YN', 'HQ_CATE', 'PJT_CD_CATE', 'MCLASS_CATE', 'DCLASS_CATE',
    'ICLASS_CATE', 'OUCM_NM_CATE', 'TAG_CATE', 'ALIAS',
}

_TAG_RE = re.compile(r'^<([A-Z_]+)>')


def parse_sdc_txt(content: str) -> List[Dict]:
    """
    Parse SDC TXT format into a list of document dicts.
    Each document has metadata fields + 'content' (OCR text from ATTACH).
    """
    documents = []
    current_doc = {}
    in_attach = False
    attach_lines = []

    for line in content.split('\n'):
        # Check for tag at start of line
        m = _TAG_RE.match(line)
        if m:
            tag = m.group(1)
            value = line[m.end():].strip()

            if tag == 'DOCID':
                # Save previous document
                if current_doc.get('doc_id'):
                    if attach_lines:
                        current_doc['content'] = '\n'.join(attach_lines).strip()
                        attach_lines = []
                    in_attach = False
                    documents.append(current_doc)
                current_doc = {'doc_id': value}

            elif tag == 'ATTACH':
                in_attach = True
                attach_lines = []
                if value:
                    attach_lines.append(value)

            elif tag == 'OCR_ATTACH':
                in_attach = False
                current_doc['content'] = '\n'.join(attach_lines).strip()
                attach_lines = []

            elif tag in _SINGLE_TAGS:
                key = tag.lower()
                current_doc[key] = value

        elif in_attach:
            attach_lines.append(line)

    # Save last document
    if current_doc.get('doc_id'):
        if attach_lines:
            current_doc['content'] = '\n'.join(attach_lines).strip()
        documents.append(current_doc)

    return documents


def parse_json_lessons(data) -> List[Dict]:
    """
    Parse JSON lessons data.
    Expects a list of dicts with at least 'file_nm' and 'content'.
    """
    if isinstance(data, dict):
        data = data.get('documents', [data])
    if not isinstance(data, list):
        return []

    documents = []
    for item in data:
        doc = {
            'doc_id': item.get('doc_id', str(uuid.uuid4())),
            'file_nm': item.get('file_nm', ''),
            'mclass': item.get('mclass', ''),
            'dclass': item.get('dclass', ''),
            'pjt_nm': item.get('pjt_nm', ''),
            'pjt_cd': item.get('pjt_cd', ''),
            'creator_name': item.get('creator_name', ''),
            'reg_date': item.get('reg_date', ''),
            'content': item.get('content', ''),
        }
        documents.append(doc)
    return documents


# ──────────────────────────────────────────────
# Document Classifier
# ──────────────────────────────────────────────

def classify_document(metadata: Dict) -> str:
    """
    Classify a document into categories 1.1~6.0 based on MCLASS/DCLASS/FILE_NM.
    """
    m = (metadata.get('mclass') or '').strip()
    d = (metadata.get('dclass') or '').strip()
    name = (metadata.get('file_nm') or '').strip()

    # 1. Management & Admin (1.1 ~ 1.3)
    if m == '사업관리' or '계약' in name or '정산' in name:
        if '계약' in name or '하도급' in name:
            return '1.1 계약 및 외주관리'
        if 'CM지시서' in name or '공문' in name:
            return '1.2 행정 및 지시사항'
        return '1.3 일반 사업관리'

    # 2. Design & Tech Review (2.0)
    if m == '설계' or '설계' in name:
        return '2.0 설계 및 기술검토'

    # 3. Construction (3.1 ~ 3.4)
    if m == '시공' or any(kw in name for kw in ['작업일보', '공사', '설치']):
        if '건축' in name or '토목' in name or '기초' in name or 'Culvert' in name:
            return '3.1 토목/건축 공종'
        if '기계' in name or '가열로' in name or '설비' in name:
            return '3.2 기계/설비 공종'
        if '철골' in name or '철물' in name:
            return '3.3 철골/철물 공종'
        return '3.4 시공 일반 및 작업일보'

    # 4. Quality (4.1 ~ 4.4)
    if m == '품질':
        if 'NCR' in name or '품질개선' in d:
            return '4.1 품질부적합(NCR) 및 개선'
        if '시험' in name or '강도' in name or '품질실행' in d:
            return '4.2 품질시험 및 검측'
        if '공급원' in name or '품질보증' in d:
            return '4.3 자재공급원 및 품질보증'
        return '4.4 품질관리 일반'

    # 5. Safety & Environment (5.0)
    if m == '환경' or '안전' in name or '태풍' in name or '화재' in name:
        return '5.0 안전 및 환경관리'

    # 6. Other (6.0)
    return '6.0 기타 및 미분류'


# ──────────────────────────────────────────────
# Category definitions (for tree display)
# ──────────────────────────────────────────────

CATEGORY_TREE = {
    '1. 사업관리': ['1.1 계약 및 외주관리', '1.2 행정 및 지시사항', '1.3 일반 사업관리'],
    '2. 설계': ['2.0 설계 및 기술검토'],
    '3. 시공': ['3.1 토목/건축 공종', '3.2 기계/설비 공종', '3.3 철골/철물 공종', '3.4 시공 일반 및 작업일보'],
    '4. 품질': ['4.1 품질부적합(NCR) 및 개선', '4.2 품질시험 및 검측', '4.3 자재공급원 및 품질보증', '4.4 품질관리 일반'],
    '5. 안전/환경': ['5.0 안전 및 환경관리'],
    '6. 기타': ['6.0 기타 및 미분류'],
}


# ──────────────────────────────────────────────
# Lessons Search Service
# ──────────────────────────────────────────────

class LessonsSearchService:
    def __init__(self):
        self.endpoint = settings.AZURE_SEARCH_ENDPOINT
        self.key = settings.AZURE_SEARCH_KEY
        self.index_name = INDEX_NAME

        self.client = None
        self.index_client = None
        if self.endpoint and self.key:
            try:
                credential = AzureKeyCredential(self.key)
                self.client = SearchClient(
                    endpoint=self.endpoint,
                    index_name=self.index_name,
                    credential=credential
                )
                self.index_client = SearchIndexClient(
                    endpoint=self.endpoint,
                    credential=credential
                )
            except Exception as e:
                logger.error(f"Failed to initialize Lessons Search Client: {e}")

        # Embedding client
        self.embedding_client = None
        if settings.AZURE_OPENAI_ENDPOINT and settings.AZURE_OPENAI_KEY:
            try:
                self.embedding_client = AzureOpenAI(
                    azure_endpoint=settings.AZURE_OPENAI_ENDPOINT,
                    api_key=settings.AZURE_OPENAI_KEY,
                    api_version=settings.AZURE_OPENAI_API_VERSION,
                )
            except Exception as e:
                logger.error(f"Failed to initialize embedding client: {e}")

    _ZERO_VECTOR = [0.0] * 3072
    EMBEDDING_BATCH_SIZE = 16
    EMBEDDING_PARALLEL_BATCHES = 4

    # ── Index Management ──

    def recreate_index(self):
        """Delete and recreate the index (fixes schema issues)."""
        if not self.index_client:
            raise RuntimeError("Azure Search index client not initialized")
        try:
            self.index_client.delete_index(self.index_name)
            print(f"[Lessons] Deleted index '{self.index_name}'", flush=True)
        except Exception:
            pass
        self._create_index()

    # Fields that must exist in the index (add new fields here)
    _REQUIRED_FIELDS = {"id", "doc_id", "file_nm", "mclass", "dclass", "category",
                        "content", "pjt_nm", "pjt_cd", "creator_name", "reg_date",
                        "username", "source_file", "file_path", "content_embedding"}

    def ensure_index(self):
        """Create or recreate the lessons-learned-index if schema is outdated."""
        if not self.index_client:
            raise RuntimeError("Azure Search index client not initialized")

        try:
            existing = self.index_client.get_index(self.index_name)
            existing_fields = {f.name for f in existing.fields}
            missing = self._REQUIRED_FIELDS - existing_fields
            if missing:
                print(f"[Lessons] Index missing fields {missing}, recreating...", flush=True)
                self.recreate_index()
            else:
                print(f"[Lessons] Index '{self.index_name}' schema OK", flush=True)
            return
        except Exception:
            pass  # Index doesn't exist, create it

        self._create_index()

    def _create_index(self):

        fields = [
            SimpleField(name="id", type=SearchFieldDataType.String, key=True, filterable=True),
            SearchableField(name="doc_id", type=SearchFieldDataType.String, filterable=True),
            SearchableField(name="file_nm", type=SearchFieldDataType.String, filterable=True, sortable=True),
            SearchableField(name="mclass", type=SearchFieldDataType.String, filterable=True, facetable=True),
            SearchableField(name="dclass", type=SearchFieldDataType.String, filterable=True, facetable=True),
            SearchableField(name="category", type=SearchFieldDataType.String, filterable=True, facetable=True),
            SearchableField(name="content", type=SearchFieldDataType.String),
            SearchableField(name="pjt_nm", type=SearchFieldDataType.String, filterable=True, facetable=True),
            SearchableField(name="pjt_cd", type=SearchFieldDataType.String, filterable=True),
            SearchableField(name="creator_name", type=SearchFieldDataType.String, filterable=True),
            SimpleField(name="reg_date", type=SearchFieldDataType.String, filterable=True, sortable=True),
            SimpleField(name="username", type=SearchFieldDataType.String, filterable=True),
            SimpleField(name="source_file", type=SearchFieldDataType.String, filterable=True, facetable=True),
            SimpleField(name="file_path", type=SearchFieldDataType.String, filterable=False),
            SearchField(
                name="content_embedding",
                type=SearchFieldDataType.Collection(SearchFieldDataType.Single),
                searchable=True,
                vector_search_dimensions=3072,
                vector_search_profile_name="default-profile",
            ),
        ]

        vector_search = VectorSearch(
            algorithms=[HnswAlgorithmConfiguration(name="default-algorithm")],
            profiles=[VectorSearchProfile(name="default-profile", algorithm_configuration_name="default-algorithm")],
        )

        index = SearchIndex(name=self.index_name, fields=fields, vector_search=vector_search)
        self.index_client.create_index(index)
        print(f"[Lessons] Created index '{self.index_name}'", flush=True)

    # ── Embedding ──

    def _generate_embedding(self, text: str) -> list:
        if not self.embedding_client:
            return self._ZERO_VECTOR
        try:
            truncated = text[:5500] if len(text) > 5500 else text
            response = self.embedding_client.embeddings.create(
                input=truncated,
                model=settings.AZURE_OPENAI_EMBEDDING_DEPLOYMENT,
            )
            return response.data[0].embedding
        except Exception as e:
            logger.warning(f"Embedding failed: {e}")
            return self._ZERO_VECTOR

    def _generate_embeddings_batch(self, texts: list) -> list:
        if not self.embedding_client or not texts:
            return [self._ZERO_VECTOR] * len(texts)
        try:
            truncated = [t[:5500] if len(t) > 5500 else t for t in texts]
            response = self.embedding_client.embeddings.create(
                input=truncated,
                model=settings.AZURE_OPENAI_EMBEDDING_DEPLOYMENT,
            )
            results = [self._ZERO_VECTOR] * len(texts)
            for item in response.data:
                results[item.index] = item.embedding
            return results
        except Exception as e:
            logger.warning(f"Batch embedding failed ({len(texts)} texts): {e}")
            return [self._ZERO_VECTOR] * len(texts)

    def _generate_all_embeddings(self, texts: list) -> list:
        if not self.embedding_client or not texts:
            return [self._ZERO_VECTOR] * len(texts)

        total = len(texts)
        results = [self._ZERO_VECTOR] * total

        batches = []
        for i in range(0, total, self.EMBEDDING_BATCH_SIZE):
            batch_texts = texts[i:i + self.EMBEDDING_BATCH_SIZE]
            batches.append((i, batch_texts))

        print(f"[Lessons] Generating embeddings: {total} texts in {len(batches)} batches", flush=True)

        with ThreadPoolExecutor(max_workers=self.EMBEDDING_PARALLEL_BATCHES) as executor:
            futures = {}
            for start_idx, batch_texts in batches:
                future = executor.submit(self._generate_embeddings_batch, batch_texts)
                futures[future] = start_idx

            for future in as_completed(futures):
                start_idx = futures[future]
                try:
                    batch_results = future.result()
                    for j, emb in enumerate(batch_results):
                        results[start_idx + j] = emb
                except Exception as e:
                    logger.warning(f"Embedding batch at {start_idx} failed: {e}")

        return results

    # ── Indexing ──

    def index_documents(self, documents: List[Dict], username: str, source_file: str) -> int:
        """
        Classify, embed, and upload documents to the lessons index.
        Returns the number of documents indexed.
        """
        if not self.client:
            raise RuntimeError("Azure Search client not initialized")

        self.ensure_index()

        # Phase 1: Classify all documents
        for doc in documents:
            doc['category'] = classify_document(doc)

        # Phase 2: Generate embeddings for all content
        texts = []
        for doc in documents:
            # Combine file name + content for better embedding
            text = f"{doc.get('file_nm', '')} {doc.get('mclass', '')} {doc.get('dclass', '')} {doc.get('content', '')}"
            texts.append(text.strip() or "empty")

        embeddings = self._generate_all_embeddings(texts)

        # Phase 3: Prepare search documents
        search_docs = []
        for i, doc in enumerate(documents):
            doc_id = doc.get('doc_id', str(uuid.uuid4()))
            # Create a deterministic ID from doc_id
            safe_id = re.sub(r'[^a-zA-Z0-9_-]', '_', doc_id)

            search_doc = {
                "id": safe_id,
                "doc_id": doc_id,
                "file_nm": doc.get('file_nm', ''),
                "mclass": doc.get('mclass', ''),
                "dclass": doc.get('dclass', ''),
                "category": doc.get('category', '6.0 기타 및 미분류'),
                "content": (doc.get('content') or '')[:30000],  # Truncate very long content
                "pjt_nm": doc.get('pjt_nm', ''),
                "pjt_cd": doc.get('pjt_cd', ''),
                "creator_name": doc.get('creator_name', ''),
                "reg_date": doc.get('reg_date', ''),
                "username": username,
                "source_file": source_file,
                "file_path": doc.get('file_path', ''),
                "content_embedding": embeddings[i],
            }
            search_docs.append(search_doc)

        # Phase 4: Upload in batches
        indexed = 0
        batch_size = 50
        for i in range(0, len(search_docs), batch_size):
            batch = search_docs[i:i + batch_size]
            try:
                result = self.client.upload_documents(documents=batch)
                success = sum(1 for r in result if r.succeeded)
                indexed += success
                print(f"[Lessons] Uploaded batch {i // batch_size + 1}: {success}/{len(batch)}", flush=True)
            except Exception as e:
                logger.error(f"Upload batch failed: {e}")

        print(f"[Lessons] Total indexed: {indexed}/{len(search_docs)}", flush=True)
        return indexed

    # ── Search ──

    def hybrid_search(self, query: str, category: Optional[str] = None,
                      username: Optional[str] = None, top: int = 20,
                      source_file: Optional[str] = None) -> List[Dict]:
        """
        Hybrid search: keyword + vector search with optional category/source_file filter.
        Returns Azure Search highlights when available.
        """
        if not self.client:
            return []

        # Build filter
        filters = []
        if category:
            safe_cat = category.replace("'", "''")
            filters.append(f"category eq '{safe_cat}'")
        if username:
            safe_user = username.replace("'", "''")
            filters.append(f"username eq '{safe_user}'")
        if source_file:
            safe_sf = source_file.replace("'", "''")
            filters.append(f"source_file eq '{safe_sf}'")

        filter_str = " and ".join(filters) if filters else None

        # Generate query embedding
        query_vector = self._generate_embedding(query)

        vector_query = VectorizedQuery(
            vector=query_vector,
            k_nearest_neighbors=top,
            fields="content_embedding"
        )

        try:
            select_fields = "doc_id,file_nm,mclass,dclass,category,content,pjt_nm,pjt_cd,creator_name,reg_date,username,source_file,file_path"
            try:
                results = self.client.search(
                    search_text=query,
                    vector_queries=[vector_query],
                    filter=filter_str,
                    top=top,
                    select=select_fields,
                    highlight_fields="content",
                    highlight_pre_tag="<mark>",
                    highlight_post_tag="</mark>",
                )
                # Force iteration to trigger any lazy errors
                result_list = []
                for r in results:
                    result_list.append(r)
            except Exception:
                # Fallback: select without file_path (old schema)
                print("[Lessons] Retrying search without file_path field", flush=True)
                results = self.client.search(
                    search_text=query,
                    vector_queries=[vector_query],
                    filter=filter_str,
                    top=top,
                    select="doc_id,file_nm,mclass,dclass,category,content,pjt_nm,pjt_cd,creator_name,reg_date,username,source_file",
                    highlight_fields="content",
                    highlight_pre_tag="<mark>",
                    highlight_post_tag="</mark>",
                )
                result_list = list(results)

            final_list = []
            for r in result_list:
                azure_highlights = (r.get("@search.highlights") or {}).get("content", [])
                final_list.append({
                    "doc_id": r.get("doc_id", ""),
                    "file_nm": r.get("file_nm", ""),
                    "mclass": r.get("mclass", ""),
                    "dclass": r.get("dclass", ""),
                    "category": r.get("category", ""),
                    "content_preview": (r.get("content") or "")[:500],
                    "content": r.get("content", ""),
                    "pjt_nm": r.get("pjt_nm", ""),
                    "pjt_cd": r.get("pjt_cd", ""),
                    "creator_name": r.get("creator_name", ""),
                    "reg_date": r.get("reg_date", ""),
                    "source_file": r.get("source_file", ""),
                    "file_path": r.get("file_path", ""),
                    "score": r.get("@search.score", 0),
                    "azure_highlights": azure_highlights,
                })
            return final_list

        except Exception as e:
            logger.error(f"Search failed: {e}")
            return []

    # ── Category Facets ──

    def get_category_counts(self, username: Optional[str] = None) -> Dict[str, int]:
        """Get document counts per category using facets."""
        if not self.client:
            return {}

        filter_str = None
        if username:
            safe_user = username.replace("'", "''")
            filter_str = f"username eq '{safe_user}'"

        try:
            results = self.client.search(
                search_text="*",
                filter=filter_str,
                facets=["category"],
                top=0,
            )

            counts = {}
            for facet in results.get_facets().get("category", []):
                counts[facet["value"]] = facet["count"]
            return counts

        except Exception as e:
            logger.error(f"Category facets failed: {e}")
            return {}

    def get_documents_by_category(self, category: str, username: Optional[str] = None,
                                   top: int = 100) -> List[Dict]:
        """Get all documents in a specific category."""
        if not self.client:
            return []

        filters = [f"category eq '{category.replace(chr(39), chr(39)*2)}'"]
        if username:
            safe_user = username.replace("'", "''")
            filters.append(f"username eq '{safe_user}'")

        try:
            results = self.client.search(
                search_text="*",
                filter=" and ".join(filters),
                top=top,
                select="doc_id,file_nm,mclass,dclass,category,pjt_nm,pjt_cd,creator_name,reg_date,file_path,content,source_file",
                order_by="file_nm",
            )

            return [
                {
                    "doc_id": r.get("doc_id", ""),
                    "file_nm": r.get("file_nm", ""),
                    "mclass": r.get("mclass", ""),
                    "dclass": r.get("dclass", ""),
                    "category": r.get("category", ""),
                    "pjt_nm": r.get("pjt_nm", ""),
                    "pjt_cd": r.get("pjt_cd", ""),
                    "creator_name": r.get("creator_name", ""),
                    "reg_date": r.get("reg_date", ""),
                    "file_path": r.get("file_path", ""),
                    "content": r.get("content", ""),
                    "source_file": r.get("source_file", ""),
                }
                for r in results
            ]

        except Exception as e:
            logger.error(f"Documents by category failed: {e}")
            return []

    def get_uploaded_files(self, username: Optional[str] = None) -> List[Dict]:
        """Get list of uploaded source files. If username is None, return all users' files."""
        if not self.client:
            return []

        filter_str = None
        if username:
            safe_user = username.replace("'", "''")
            filter_str = f"username eq '{safe_user}'"

        try:
            results = self.client.search(
                search_text="*",
                filter=filter_str,
                facets=["source_file"],
                top=0,
            )

            files = []
            for facet in results.get_facets().get("source_file", []):
                filename = facet["value"]
                # Fetch pjt_cd from the first document of this source file
                pjt_cd = ""
                pjt_nm = ""
                try:
                    detail_filter = f"source_file eq '{filename.replace(chr(39), chr(39)+chr(39))}'"
                    if filter_str:
                        detail_filter = f"{filter_str} and {detail_filter}"
                    doc_results = self.client.search(
                        search_text="*",
                        filter=detail_filter,
                        select=["pjt_cd", "pjt_nm"],
                        top=1,
                    )
                    for doc in doc_results:
                        pjt_cd = doc.get("pjt_cd", "") or ""
                        pjt_nm = doc.get("pjt_nm", "") or ""
                        break
                except Exception:
                    pass
                files.append({
                    "filename": filename,
                    "document_count": facet["count"],
                    "pjt_cd": pjt_cd,
                    "pjt_nm": pjt_nm,
                })
            return files

        except Exception as e:
            logger.error(f"Get uploaded files failed: {e}")
            return []

    def delete_by_source_file(self, source_file: str, username: str) -> int:
        """Delete all indexed documents from a specific source file."""
        if not self.client:
            return 0

        safe_user = username.replace("'", "''")
        safe_file = source_file.replace("'", "''")

        try:
            results = self.client.search(
                search_text="*",
                filter=f"username eq '{safe_user}' and source_file eq '{safe_file}'",
                select="id",
                top=1000,
            )

            ids_to_delete = [{"id": r["id"]} for r in results]
            if not ids_to_delete:
                return 0

            result = self.client.delete_documents(documents=ids_to_delete)
            deleted = sum(1 for r in result if r.succeeded)
            print(f"[Lessons] Deleted {deleted} docs from '{source_file}'", flush=True)
            return deleted

        except Exception as e:
            logger.error(f"Delete by source file failed: {e}")
            return 0


# Global singleton
lessons_search_service = LessonsSearchService()
