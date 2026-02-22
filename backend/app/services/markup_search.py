"""
Markup Search Service — Azure AI Search indexing for PlantSync markups.

- Index: markup-search-index
- Embedding: text-embedding-3-large (3072d)
- Hybrid search (keyword + vector) with project-scoped filtering
"""

import logging
import re
from typing import List, Dict, Optional

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

INDEX_NAME = "markup-search-index"


class MarkupSearchService:
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
                    credential=credential,
                )
                self.index_client = SearchIndexClient(
                    endpoint=self.endpoint,
                    credential=credential,
                )
            except Exception as e:
                logger.error(f"Failed to initialize Markup Search Client: {e}")

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

    _REQUIRED_FIELDS = {
        "id", "project_id", "drawing_id", "markup_id",
        "discipline", "issue_category", "impact_level",
        "related_tag_no", "custom_tags", "author_name",
        "status", "content", "content_embedding",
    }

    # ── Index Management ──

    def ensure_index(self):
        """Create or verify the markup-search-index."""
        if not self.index_client:
            raise RuntimeError("Azure Search index client not initialized")

        try:
            existing = self.index_client.get_index(self.index_name)
            existing_fields = {f.name for f in existing.fields}
            missing = self._REQUIRED_FIELDS - existing_fields
            if missing:
                print(f"[Markup] Index missing fields {missing}, recreating...", flush=True)
                self.recreate_index()
            else:
                print(f"[Markup] Index '{self.index_name}' schema OK", flush=True)
            return
        except Exception:
            pass

        self._create_index()

    def recreate_index(self):
        """Delete and recreate the index."""
        if not self.index_client:
            raise RuntimeError("Azure Search index client not initialized")
        try:
            self.index_client.delete_index(self.index_name)
            print(f"[Markup] Deleted index '{self.index_name}'", flush=True)
        except Exception:
            pass
        self._create_index()

    def _create_index(self):
        fields = [
            SimpleField(name="id", type=SearchFieldDataType.String, key=True, filterable=True),
            SimpleField(name="project_id", type=SearchFieldDataType.String, filterable=True),
            SimpleField(name="drawing_id", type=SearchFieldDataType.String, filterable=True),
            SimpleField(name="markup_id", type=SearchFieldDataType.String, filterable=True),
            SearchableField(name="discipline", type=SearchFieldDataType.String, filterable=True, facetable=True),
            SearchableField(name="issue_category", type=SearchFieldDataType.String, filterable=True, facetable=True),
            SearchableField(name="impact_level", type=SearchFieldDataType.String, filterable=True, facetable=True),
            SearchableField(name="related_tag_no", type=SearchFieldDataType.String, filterable=True),
            SearchableField(name="custom_tags", type=SearchFieldDataType.String),
            SimpleField(name="author_name", type=SearchFieldDataType.String, filterable=True),
            SimpleField(name="status", type=SearchFieldDataType.String, filterable=True, facetable=True),
            SearchableField(name="content", type=SearchFieldDataType.String),
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
        print(f"[Markup] Created index '{self.index_name}'", flush=True)

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
            logger.warning(f"Markup embedding failed: {e}")
            return self._ZERO_VECTOR

    # ── Text Synthesis ──

    def synthesize_text(self, markup_data: dict) -> str:
        """Combine all structured fields into a searchable natural-language paragraph."""
        parts = ["프로젝트 마크업."]

        discipline = markup_data.get("discipline", "")
        if discipline:
            parts.append(f"공종: {discipline}.")

        issue_category = markup_data.get("issue_category", "")
        if issue_category:
            parts.append(f"이슈 유형: {issue_category}.")

        impact_level = markup_data.get("impact_level", "")
        if impact_level and impact_level != "normal":
            parts.append(f"영향도: {impact_level}.")

        related_tag_no = markup_data.get("related_tag_no", "")
        if related_tag_no:
            parts.append(f"관련 기기: {related_tag_no}.")

        custom_tags = markup_data.get("custom_tags", [])
        if custom_tags:
            tag_str = " ".join(t if t.startswith("#") else f"#{t}" for t in custom_tags)
            parts.append(f"태그: {tag_str}.")

        target_disciplines = markup_data.get("target_disciplines", [])
        if target_disciplines:
            parts.append(f"대상 공종: {', '.join(target_disciplines)}.")

        comment = markup_data.get("comment", "")
        if comment:
            parts.append(f"코멘트: {comment}")

        extracted_tags = markup_data.get("extracted_tags", [])
        if extracted_tags:
            parts.append(f"추출 태그: {', '.join(extracted_tags)}.")

        resolution = markup_data.get("resolution_comment", "")
        if resolution:
            parts.append(f"해결: {resolution}")

        root_cause = markup_data.get("root_cause", "")
        if root_cause:
            parts.append(f"원인: {root_cause}.")

        return " ".join(parts)

    # ── Indexing ──

    def index_markup(self, project_id: str, markup_data: dict) -> bool:
        """Synthesize text, generate embedding, and upload a single markup to the index."""
        if not self.client:
            return False

        self.ensure_index()

        markup_id = markup_data.get("markup_id", "")
        drawing_id = markup_data.get("drawing_id", "")
        safe_id = re.sub(r'[^a-zA-Z0-9_-]', '_', f"{project_id}_{markup_id}")

        content = self.synthesize_text(markup_data)
        embedding = self._generate_embedding(content)

        custom_tags = markup_data.get("custom_tags", [])
        tags_joined = ", ".join(custom_tags) if custom_tags else ""

        doc = {
            "id": safe_id,
            "project_id": project_id,
            "drawing_id": drawing_id,
            "markup_id": markup_id,
            "discipline": markup_data.get("discipline", ""),
            "issue_category": markup_data.get("issue_category", ""),
            "impact_level": markup_data.get("impact_level", "normal"),
            "related_tag_no": markup_data.get("related_tag_no", ""),
            "custom_tags": tags_joined,
            "author_name": markup_data.get("author_name", ""),
            "status": markup_data.get("status", "open"),
            "content": content[:30000],
            "content_embedding": embedding,
        }

        try:
            result = self.client.upload_documents(documents=[doc])
            success = sum(1 for r in result if r.succeeded)
            if success:
                print(f"[Markup] Indexed markup {markup_id} (project={project_id})", flush=True)
            return success > 0
        except Exception as e:
            logger.error(f"Markup index upload failed: {e}")
            return False

    def delete_markup(self, markup_id: str, project_id: str) -> bool:
        """Delete a single markup from the index."""
        if not self.client:
            return False
        try:
            safe_id = re.sub(r'[^a-zA-Z0-9_-]', '_', f"{project_id}_{markup_id}")
            result = self.client.delete_documents(documents=[{"id": safe_id}])
            success = sum(1 for r in result if r.succeeded)
            if success:
                print(f"[Markup] Deleted markup {markup_id} from index", flush=True)
            return success > 0
        except Exception as e:
            logger.error(f"Markup index delete failed: {e}")
            return False

    # ── Hybrid Search ──

    def hybrid_search(self, query: str, project_id: Optional[str] = None,
                      discipline: Optional[str] = None, top: int = 10) -> List[Dict]:
        """Keyword + vector hybrid search over indexed markups."""
        if not self.client:
            return []

        filters = []
        if project_id:
            filters.append(f"project_id eq '{project_id.replace(chr(39), chr(39)*2)}'")
        if discipline:
            filters.append(f"discipline eq '{discipline.replace(chr(39), chr(39)*2)}'")

        filter_str = " and ".join(filters) if filters else None

        query_vector = self._generate_embedding(query)
        vector_queries = [VectorizedQuery(
            vector=query_vector,
            k_nearest_neighbors=top,
            fields="content_embedding",
        )]

        try:
            results = self.client.search(
                search_text=query,
                vector_queries=vector_queries,
                filter=filter_str,
                top=top,
                select="project_id,drawing_id,markup_id,discipline,issue_category,impact_level,related_tag_no,custom_tags,author_name,status,content",
                highlight_fields="content",
                highlight_pre_tag="<mark>",
                highlight_post_tag="</mark>",
            )

            final_list = []
            for r in results:
                final_list.append({
                    "project_id": r.get("project_id", ""),
                    "drawing_id": r.get("drawing_id", ""),
                    "markup_id": r.get("markup_id", ""),
                    "discipline": r.get("discipline", ""),
                    "issue_category": r.get("issue_category", ""),
                    "impact_level": r.get("impact_level", ""),
                    "related_tag_no": r.get("related_tag_no", ""),
                    "custom_tags": r.get("custom_tags", ""),
                    "author_name": r.get("author_name", ""),
                    "status": r.get("status", ""),
                    "content": r.get("content", ""),
                    "content_preview": (r.get("content") or "")[:300],
                    "score": r.get("@search.score", 0),
                })
            return final_list

        except Exception as e:
            logger.error(f"Markup hybrid search failed: {e}")
            return []


# Global singleton
markup_search_service = MarkupSearchService()
