"""
KCSC (국가건설기준센터) OpenAPI 연동 엔드포인트

- POST /chat : RAG 채팅 (키워드 추출 → 기준 검색 → 본문 조회 → LLM 답변)
- GET  /sections : 특정 기준의 전체 섹션 조회
"""

import re
import time
import urllib3
from typing import Any, Dict, List, Optional, Tuple

import requests
from bs4 import BeautifulSoup
from difflib import SequenceMatcher
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from openai import AzureOpenAI
from pydantic import BaseModel

from app.core.config import settings

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

router = APIRouter()

# ---------------------------------------------------------------------------
# Azure OpenAI client (reuse existing settings)
# ---------------------------------------------------------------------------
_oai_client: Optional[AzureOpenAI] = None


def _get_oai_client() -> AzureOpenAI:
    global _oai_client
    if _oai_client is None:
        _oai_client = AzureOpenAI(
            api_key=settings.AZURE_OPENAI_KEY,
            api_version=settings.AZURE_OPENAI_API_VERSION,
            azure_endpoint=settings.AZURE_OPENAI_ENDPOINT,
        )
    return _oai_client


# ---------------------------------------------------------------------------
# CodeList cache (module-level, 6-hour TTL)
# ---------------------------------------------------------------------------
_code_list_cache: Dict[str, Any] = {}
_code_list_ts: Dict[str, float] = {}
_CACHE_TTL = 6 * 3600  # 6 hours


# ---------------------------------------------------------------------------
# KCSCBot – ported from KCSC/app.py
# ---------------------------------------------------------------------------
class KCSCBot:
    def __init__(self, api_key: str):
        self.api_key = api_key
        self.base_url = "https://kcsc.re.kr/OpenApi"
        self.session = requests.Session()
        self.session.verify = False
        self.session.headers.update({
            "User-Agent": "Mozilla/5.0 (KCSC-Client)",
            "Accept": "application/json, text/plain;q=0.9, */*;q=0.8",
        })

    # ---------- Utilities ----------
    @staticmethod
    def _strip_html(s: str) -> str:
        if not s:
            return ""
        if "<" not in s or ">" not in s:
            return s
        soup = BeautifulSoup(s, "html.parser")
        for table in soup.find_all("table"):
            md_rows: List[str] = []
            rows = table.find_all("tr")
            for i, row in enumerate(rows):
                cells = row.find_all(["th", "td"])
                cell_texts = [c.get_text(strip=True).replace("|", "/") for c in cells]
                md_rows.append("| " + " | ".join(cell_texts) + " |")
                if i == 0:
                    md_rows.append("| " + " | ".join(["---"] * len(cell_texts)) + " |")
            table.replace_with("\n" + "\n".join(md_rows) + "\n")
        for img in soup.find_all("img"):
            alt = img.get("alt", "").strip()
            placeholder = f"[그림: {alt}]" if alt else "[그림]"
            img.replace_with(placeholder)
        return soup.get_text(separator="\n", strip=True)

    @staticmethod
    def _get_first(item: Dict[str, Any], keys: List[str], default: str = "") -> str:
        for k in keys:
            v = item.get(k)
            if v not in (None, ""):
                return str(v)
        return default

    @staticmethod
    def _redact_key(text: str, key: str) -> str:
        return (text or "").replace(key, "***REDACTED***") if key else (text or "")

    def _get_json(self, endpoint: str, params: Optional[Dict[str, Any]] = None, *, path: Optional[str] = None) -> Any:
        url = f"{self.base_url}/{path}" if path else f"{self.base_url}/{endpoint}"
        params = dict(params or {})
        params.setdefault("key", self.api_key)
        res = self.session.get(url, params=params, timeout=25)
        res.raise_for_status()
        text = (res.text or "").lstrip()
        if text.lower().startswith("<!doctype html") or text.lower().startswith("<html"):
            raise RuntimeError("KCSC OpenAPI가 JSON 대신 HTML을 반환했습니다.")
        try:
            return res.json()
        except Exception as e:
            raise RuntimeError(f"KCSC OpenAPI 응답 JSON 파싱 실패: {e}")

    # ---------- Keyword Extraction ----------
    def get_search_keyword(self, user_query: str) -> str:
        """Legacy wrapper - returns keyword only."""
        _, keyword = self.get_code_suggestion(user_query)
        return keyword

    def get_code_suggestion(self, user_query: str) -> Tuple[List[str], str]:
        """Ask LLM to suggest specific KDS/KCS codes AND search keywords.
        Returns (list of 'TYPE CODE' strings, keyword string).
        """
        prompt = (
            f"사용자 질문: '{user_query}'\n\n"
            "당신은 국가건설기준(KDS/KCS/KWCS) 전문가입니다. 아래 두 가지를 출력하세요:\n\n"
            "1행: 이 질문과 가장 관련된 KDS/KCS 기준 코드를 최대 3개, 쉼표로 구분\n"
            "   예: KDS 14 20 30, KCS 14 20 10\n"
            "   모르면 '없음'이라고 쓰세요.\n"
            "2행: 기준서 제목 검색용 핵심 단어 1~3개 (공백 구분)\n"
            "   예: 콘크리트 사용성 균열\n\n"
            "설명 없이 2행만 출력하세요."
        )
        codes: List[str] = []
        keyword = user_query
        try:
            client = _get_oai_client()
            response = client.chat.completions.create(
                model=settings.AZURE_OPENAI_DEPLOYMENT_NAME,
                messages=[
                    {"role": "system", "content": "Output exactly 2 lines. Line 1: comma-separated KDS/KCS codes or '없음'. Line 2: Korean search keywords."},
                    {"role": "user", "content": prompt},
                ],
            )
            lines = response.choices[0].message.content.strip().splitlines()
            # Parse line 1: codes
            if lines and lines[0].strip() != "없음":
                for part in lines[0].split(","):
                    part = part.strip()
                    m = re.search(r"(KDS|KCS|KWCS)\s*(\d{2})\s*(\d{2})\s*(\d{2,3})", part, re.IGNORECASE)
                    if m:
                        codes.append(f"{m.group(1).upper()} {m.group(2)} {m.group(3)} {m.group(4)}")
            # Parse line 2: keywords
            if len(lines) >= 2:
                kw = re.sub(r"[^0-9A-Za-z가-힣\s]", " ", lines[1])
                kw = " ".join(kw.split())
                if kw:
                    keyword = kw
            print(f"[KCSC] LLM suggested codes={codes}, keyword='{keyword}'", flush=True)
        except Exception as e:
            print(f"[KCSC] code suggestion failed: {e}", flush=True)
        return codes, keyword

    # ---------- CodeList / Search ----------
    def get_code_list(self, doc_type: str = "KCS") -> List[Dict[str, Any]]:
        global _code_list_cache, _code_list_ts
        cache_key = f"kcsc_codelist_{doc_type}"
        now = time.time()
        if cache_key in _code_list_cache and (now - _code_list_ts.get(cache_key, 0)) < _CACHE_TTL:
            return _code_list_cache[cache_key]
        data = self._get_json("CodeList", params={"Type": doc_type})
        if not isinstance(data, list):
            raise RuntimeError(f"CodeList 응답 형식이 예상과 다릅니다: {type(data)}")
        _code_list_cache[cache_key] = data
        _code_list_ts[cache_key] = now
        return data

    def _normalize_tokens(self, keyword: str) -> List[str]:
        raw = [t for t in keyword.split() if t]
        expanded: List[str] = []
        strip_patterns = [
            (r"^(최소|최대|기준|규정|설계|시공|내구|내구성|환경|노출|조건)", ""),
            (r"(기준|규정|환경|노출|조건)$", ""),
        ]
        for t in raw:
            t0 = t
            for pat, rep in strip_patterns:
                t0 = re.sub(pat, rep, t0)
            t0 = t0.strip()
            if t0 and t0 not in raw:
                expanded.append(t0)
            if "피복" in t:
                expanded += ["피복", "피복두께"]
            if "피복두께" in t:
                expanded += ["피복두께", "피복"]
            if "염해" in t or "해안" in t:
                expanded += ["염해", "해안", "염분"]
            if "내구" in t:
                expanded += ["내구", "내구성", "내구설계"]
            if "철근" in t:
                expanded += ["철근", "철근콘크리트", "RC"]
            if "콘크리트" in t:
                expanded += ["콘크리트", "철근콘크리트", "RC"]
        tokens = raw + expanded
        uniq: List[str] = []
        for t in tokens:
            t = t.strip()
            if len(t) < 2:
                continue
            if t not in uniq:
                uniq.append(t)
        return uniq

    def extract_code_number(self, query: str) -> Optional[str]:
        match = re.search(r"(\d{1,2}[\s\.-]?\d{2}[\s\.-]?\d{2,3})", query)
        if match:
            return re.sub(r"[\s\.-]", "", match.group(1))
        return None

    _GENERIC_TERMS = {"기준", "설계", "시공", "공사", "일반", "구조", "건축", "공통", "표준"}

    def search_codes_local(self, keyword: str, doc_type: str = "KCS", top_k: int = 10) -> List[Dict[str, Any]]:
        items = self.get_code_list(doc_type=doc_type)
        name_keys = ["Name", "name", "TITLE", "Title"]
        code_keys = ["Code", "code", "CODE", "FullCode", "fullCode"]

        def get_name(it):
            return self._get_first(it, name_keys)

        def get_code(it):
            return self._get_first(it, code_keys)

        # Fast track: code number
        extracted_code = self.extract_code_number(keyword)
        if extracted_code:
            fast = []
            for it in items:
                for k in code_keys:
                    val = it.get(k)
                    if val and extracted_code in str(val).replace(" ", "").replace(".", "").replace("-", ""):
                        fast.append(it)
                        break
            if fast:
                fast.sort(key=lambda x: len(get_code(x)))
                return fast[:top_k]

        # Token matching
        tokens = self._normalize_tokens(keyword)

        def score_contains(it):
            name = get_name(it)
            if not name:
                return 0.0
            name_l = name.lower()
            s = 0.0
            matched = 0
            for t in tokens:
                if t.lower() in name_l:
                    s += 1 if t in self._GENERIC_TERMS else max(len(t), 3)
                    matched += 1
            if matched >= 2:
                s *= (1.0 + 0.3 * matched)
            return s

        ranked = sorted(items, key=score_contains, reverse=True)
        ranked = [x for x in ranked if score_contains(x) > 0]

        if not ranked:
            key_compact = "".join(tokens) if tokens else keyword

            def ratio(it):
                name = get_name(it)
                return SequenceMatcher(None, key_compact.lower(), name.lower()).ratio() if name else 0.0

            fuzzy = sorted(items, key=ratio, reverse=True)
            ranked = [x for x in fuzzy if ratio(x) >= 0.20]

        cleaned = []
        for it in ranked:
            if get_code(it).strip():
                cleaned.append(it)
            if len(cleaned) >= top_k:
                break
        return cleaned

    def search_all_types(self, keyword: str, top_k: int = 10) -> Tuple[str, List[Dict[str, Any]]]:
        all_results: List[Dict[str, Any]] = []
        best_type = ""
        for dtype in ["KDS", "KCS", "KWCS"]:
            try:
                results = self.search_codes_local(keyword, doc_type=dtype, top_k=top_k)
                if results and not all_results:
                    best_type = str(results[0].get("codeType") or results[0].get("CodeType") or dtype)
                all_results.extend(results)
            except Exception:
                pass
        # De-duplicate by code and return top_k
        seen: set = set()
        unique: List[Dict[str, Any]] = []
        code_keys = ["Code", "code", "CODE", "FullCode", "fullCode"]
        for it in all_results:
            c = self._get_first(it, code_keys)
            if c not in seen:
                seen.add(c)
                unique.append(it)
            if len(unique) >= top_k:
                break
        return best_type, unique

    # ---------- CodeViewer ----------
    def _fetch_raw_sections(self, code: str, doc_type: str) -> Tuple[str, List[Dict[str, Any]]]:
        try:
            data = self._get_json("", params={}, path=f"CodeViewer/{doc_type}/{code}")
        except Exception:
            data = self._get_json("CodeViewer", params={"Type": doc_type, "Code": code})
        if isinstance(data, list):
            if not data:
                return "", []
            data = data[0]
        code_name = str(data.get("Name") or data.get("name") or "")
        lst = data.get("List") or data.get("list") or []
        if not isinstance(lst, list):
            lst = [{"title": "", "contents": str(lst)}]
        return code_name, lst

    def _sections_to_text(self, sections: List[Dict[str, Any]]) -> str:
        parts: List[str] = []
        for sec in sections:
            title = str(sec.get("Title") or sec.get("title") or "").strip()
            title = re.sub(r"<img[^>]*>", "", title).strip()
            contents = sec.get("Contents") or sec.get("contents") or ""
            contents = self._strip_html(str(contents))
            if title:
                parts.append(f"## {title}\n{contents}".strip())
            elif contents.strip():
                parts.append(contents.strip())
        return "\n\n".join([p for p in parts if p])

    @staticmethod
    def _expand_tokens(tokens: List[str]) -> List[Tuple[str, float]]:
        result: List[Tuple[str, float]] = []
        seen: set = set()
        for t in tokens:
            t_low = t.lower()
            if t_low not in seen:
                result.append((t_low, min(len(t), 6)))
                seen.add(t_low)
            if len(t) >= 3:
                for j in range(len(t) - 1):
                    sub = t[j:j + 2].lower()
                    if len(sub) >= 2 and sub not in seen:
                        result.append((sub, 1.0))
                        seen.add(sub)
            if len(t) >= 4:
                for j in range(len(t) - 2):
                    sub = t[j:j + 3].lower()
                    if sub not in seen:
                        result.append((sub, 2.0))
                        seen.add(sub)
        return result

    def _extract_relevant_sections(
        self, sections: List[Dict[str, Any]], query: str, keyword: str, max_chars: int = 15000
    ) -> str:
        full_text = self._sections_to_text(sections)
        if len(full_text) <= max_chars:
            return full_text

        combined = f"{query} {keyword}"
        raw_tokens = [t for t in combined.split() if len(t) >= 2]
        stopwords = {
            "에서", "이란", "무엇", "얼마", "어떻게", "대한", "대해", "알려줘",
            "설명해", "기준", "지역의", "지역", "대하여", "관한", "관련",
        }
        seen: set = set()
        unique_tokens: List[str] = []
        for t in raw_tokens:
            t_low = t.lower()
            if t_low not in seen and t_low not in stopwords:
                unique_tokens.append(t)
                seen.add(t_low)

        weighted_tokens = self._expand_tokens(unique_tokens)

        scored: List[Tuple[float, int, str]] = []
        for i, sec in enumerate(sections):
            title = str(sec.get("Title") or sec.get("title") or "")
            title = re.sub(r"<img[^>]*>", "", title).strip()
            contents_raw = str(sec.get("Contents") or sec.get("contents") or "")
            contents_text = self._strip_html(contents_raw)
            searchable = f"{title} {contents_text}".lower()

            score = 0.0
            matched_count = 0
            for t_low, weight in weighted_tokens:
                if t_low in searchable:
                    score += weight
                    matched_count += 1
                    if t_low in title.lower():
                        score += weight * 0.5
            if matched_count >= 3:
                score *= (1.0 + 0.2 * matched_count)
            if score > 0:
                block = f"## {title}\n{contents_text}".strip() if title else contents_text.strip()
                scored.append((score, i, block))

        scored.sort(key=lambda x: (-x[0], x[1]))

        top_indices: set = set()
        for _, idx, _ in scored[:20]:
            top_indices.add(idx)
            if idx > 0:
                top_indices.add(idx - 1)
            if idx < len(sections) - 1:
                top_indices.add(idx + 1)

        all_blocks: Dict[int, str] = {}
        for _, idx, block in scored:
            all_blocks[idx] = block
        for idx in top_indices:
            if idx not in all_blocks:
                sec = sections[idx]
                title = str(sec.get("Title") or sec.get("title") or "")
                title = re.sub(r"<img[^>]*>", "", title).strip()
                contents_text = self._strip_html(str(sec.get("Contents") or sec.get("contents") or ""))
                block = f"## {title}\n{contents_text}".strip() if title else contents_text.strip()
                all_blocks[idx] = block

        score_map: Dict[int, float] = {idx: s for s, idx, _ in scored}
        candidates = []
        for idx in top_indices:
            s = score_map.get(idx, score_map.get(idx - 1, 0) * 0.5)
            candidates.append((s, idx, all_blocks[idx]))
        candidates.sort(key=lambda x: (-x[0], x[1]))

        selected: List[Tuple[int, str]] = []
        total_len = 0
        for score, idx, block in candidates:
            if not block.strip():
                continue
            if total_len + len(block) > max_chars:
                remaining = max_chars - total_len
                if remaining > 200:
                    selected.append((idx, block[:remaining] + "\n... (이하 생략)"))
                break
            selected.append((idx, block))
            total_len += len(block) + 2

        if not selected:
            return full_text[:max_chars]

        selected.sort(key=lambda x: x[0])
        return "\n\n".join([text for _, text in selected])

    def get_sections_with_ids(self, code: str, doc_type: str) -> Tuple[str, List[Dict[str, Any]]]:
        """Fetch sections and assign section_id to each."""
        code_name, raw_sections = self._fetch_raw_sections(code, doc_type)
        sections = []
        for i, sec in enumerate(raw_sections):
            title = str(sec.get("Title") or sec.get("title") or "").strip()
            title = re.sub(r"<img[^>]*>", "", title).strip()
            contents = str(sec.get("Contents") or sec.get("contents") or "")
            sections.append({
                "section_id": f"sec-{i}",
                "Title": title,
                "Contents": contents,
            })
        return code_name, sections

    def get_content_for_llm(self, code: str, doc_type: str, query: str = "", keyword: str = "") -> Tuple[str, str, List[Dict[str, Any]]]:
        """Get content for LLM context + raw sections with IDs."""
        code_name, sections = self.get_sections_with_ids(code, doc_type)
        if not sections:
            return code_name, "", []

        # Build raw section list for _extract_relevant_sections
        raw_sections = [{"Title": s["Title"], "Contents": s["Contents"]} for s in sections]
        if query or keyword:
            content = self._extract_relevant_sections(raw_sections, query, keyword)
        else:
            content = self._sections_to_text(raw_sections)
        return code_name, content, sections


# ---------------------------------------------------------------------------
# Singleton bot instance
# ---------------------------------------------------------------------------
_bot: Optional[KCSCBot] = None


def _get_bot() -> KCSCBot:
    global _bot
    if _bot is None:
        if not settings.KCSC_API_KEY:
            raise HTTPException(status_code=500, detail="KCSC_API_KEY is not configured")
        _bot = KCSCBot(settings.KCSC_API_KEY)
    return _bot


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------
class ChatRequest(BaseModel):
    message: str
    doc_type: str = "자동"
    top_k: int = 18
    history: List[Dict[str, str]] = []
    stream: bool = False


class SectionItem(BaseModel):
    section_id: str
    Title: str
    Contents: str


class CitationItem(BaseModel):
    section_id: str
    title: str


class SearchCandidate(BaseModel):
    Name: str
    Code: str


class ChatResponse(BaseModel):
    answer: str
    source_code: str
    source_name: str
    source_type: str
    keyword: str
    sections: List[SectionItem]
    search_candidates: List[SearchCandidate]
    citations: List[CitationItem]


# ---------------------------------------------------------------------------
# POST /chat
# ---------------------------------------------------------------------------
@router.post("/chat")
async def kcsc_chat(req: ChatRequest):
    bot = _get_bot()
    client = _get_oai_client()

    name_keys = ["Name", "name", "TITLE", "Title"]
    code_keys = ["Code", "code", "CODE", "FullCode", "fullCode"]

    content = ""
    code = ""
    code_name = ""
    doc_name = ""
    sections: List[Dict[str, Any]] = []
    search_candidates = []
    target_type = req.doc_type if req.doc_type != "자동" else ""
    keyword = ""

    # 0) Direct code detection: if user specifies e.g. "KCS 11 40 05" or "kds171000"
    direct_match = re.search(r"(KDS|KCS|KWCS)\s*(\d{2})\s*(\d{2})\s*(\d{2,3})", req.message, re.IGNORECASE)
    if direct_match:
        direct_type = direct_match.group(1).upper()
        d2, d3, d4 = direct_match.group(2), direct_match.group(3), direct_match.group(4)
        # Try multiple code formats: with spaces, compact, with dots
        code_variants = [
            f"{d2} {d3} {d4}",   # "17 10 00"
            f"{d2}{d3}{d4}",     # "171000"
            f"{d2} {d3} {d4.lstrip('0') or '0'}",  # "17 10 0" (strip leading zeros)
        ]
        print(f"[KCSC] direct code detected: {direct_type} variants={code_variants}", flush=True)

        # Try the specified type first, then try all types × all code formats
        try_types = [direct_type] + [t for t in ["KDS", "KCS", "KWCS"] if t != direct_type]
        for try_type in try_types:
            for try_code in code_variants:
                try:
                    doc_name, content, sections = bot.get_content_for_llm(
                        try_code, doc_type=try_type, query="", keyword=""
                    )
                    if content.strip():
                        code = try_code
                        code_name = doc_name or f"{try_type} {d2} {d3} {d4}"
                        target_type = try_type
                        keyword = f"{d2} {d3} {d4}"
                        print(f"[KCSC] direct fetch OK: {code_name} ({try_type} {try_code}, {len(sections)} sections)", flush=True)
                        break
                except Exception as e:
                    print(f"[KCSC] direct fetch failed for {try_type} {try_code}: {e}", flush=True)
            if content.strip():
                break

        # Add the found standard as first search candidate
        if content.strip():
            search_candidates.append({
                "Name": code_name,
                "Code": f"{d2}{d3}{d4}",
            })

    # 1) If direct fetch didn't work, use LLM code suggestion + keyword search
    if not content.strip():
        suggested_codes, keyword = bot.get_code_suggestion(req.message)
        print(f"[KCSC] LLM suggestion: codes={suggested_codes}, keyword='{keyword}'", flush=True)

        # 1-a) Try each LLM-suggested code via direct fetch
        for suggested in suggested_codes:
            # suggested is like "KDS 14 20 30"
            sm = re.match(r"(KDS|KCS|KWCS)\s+(\d{2})\s+(\d{2})\s+(\d{2,3})", suggested, re.IGNORECASE)
            if not sm:
                continue
            s_type = sm.group(1).upper()
            s2, s3, s4 = sm.group(2), sm.group(3), sm.group(4)
            s_variants = [
                f"{s2} {s3} {s4}",
                f"{s2}{s3}{s4}",
                f"{s2} {s3} {s4.lstrip('0') or '0'}",
            ]
            s_try_types = [s_type] + [t for t in ["KDS", "KCS", "KWCS"] if t != s_type]
            for st in s_try_types:
                for sv in s_variants:
                    try:
                        doc_name, content, sections = bot.get_content_for_llm(
                            sv, doc_type=st, query=req.message, keyword=keyword
                        )
                        if content.strip():
                            code = sv
                            code_name = doc_name or f"{st} {s2} {s3} {s4}"
                            target_type = st
                            print(f"[KCSC] LLM-suggested code fetch OK: {code_name} ({st} {sv})", flush=True)
                            # Add as first search candidate
                            search_candidates.append({
                                "Name": code_name,
                                "Code": f"{s2}{s3}{s4}",
                            })
                            break
                    except Exception as e:
                        print(f"[KCSC] LLM-suggested fetch failed: {st} {sv}: {e}", flush=True)
                if content.strip():
                    break
            if content.strip():
                break

    # 1-b) If LLM-suggested codes didn't work, fall back to keyword search
    if not content.strip():
        print(f"[KCSC] falling back to keyword search: '{keyword}'", flush=True)

        # 2) Search codes
        if req.doc_type == "자동":
            target_type, results = bot.search_all_types(keyword, top_k=req.top_k)
        else:
            target_type = req.doc_type
            results = bot.search_codes_local(keyword, doc_type=target_type, top_k=req.top_k)
            if not results:
                other_types = [t for t in ["KDS", "KCS", "KWCS"] if t != target_type]
                for t in other_types:
                    results = bot.search_codes_local(keyword, doc_type=t, top_k=req.top_k)
                    if results:
                        target_type = t
                        break

        for it in results:
            search_candidates.append({
                "Name": bot._get_first(it, name_keys),
                "Code": bot._get_first(it, code_keys),
            })

        if not results:
            return ChatResponse(
                answer="관련 기준(코드)을 찾지 못했습니다. 검색어를 바꿔서 다시 시도해보세요.",
                source_code="",
                source_name="",
                source_type="",
                keyword=keyword,
                sections=[],
                search_candidates=search_candidates,
                citations=[],
            )

        # 3) Fetch content from top candidates
        for candidate in results[:5]:
            code = bot._get_first(candidate, code_keys)
            code_name = bot._get_first(candidate, name_keys, default="Unknown")
            item_type = str(candidate.get("codeType") or candidate.get("CodeType") or target_type)
            print(f"[KCSC] trying: {code_name} ({item_type} {code})", flush=True)

            doc_name, content, sections = bot.get_content_for_llm(
                code, doc_type=item_type, query=req.message, keyword=keyword
            )
            if content.strip():
                target_type = item_type
                break

    if not content.strip():
        return ChatResponse(
            answer="모든 후보 기준의 본문이 비어 있습니다. 다른 검색어로 시도해보세요.",
            source_code=code,
            source_name=code_name,
            source_type=target_type,
            keyword=keyword,
            sections=[],
            search_candidates=search_candidates,
            citations=[],
        )

    # 3-b) Cross-reference resolution: detect referenced standards and fetch them
    xref_content = ""
    xref_pattern = re.compile(r"(KDS|KCS|KWCS)\s*(\d{2})\s*(\d{2})\s*(\d{2,3})", re.IGNORECASE)
    current_code_normalized = re.sub(r"[\s\-\.]", "", code)
    found_refs: set = set()
    for m in xref_pattern.finditer(content):
        ref_type = m.group(1)
        ref_code = f"{m.group(2)} {m.group(3)} {m.group(4)}"
        ref_code_normalized = re.sub(r"[\s\-\.]", "", ref_code)
        ref_key = f"{ref_type}_{ref_code_normalized}"
        if ref_code_normalized == current_code_normalized or ref_key in found_refs:
            continue
        found_refs.add(ref_key)

    # Fetch up to 2 cross-referenced standards
    xref_parts: List[str] = []
    for ref_key in list(found_refs)[:2]:
        ref_type, ref_code_norm = ref_key.split("_", 1)
        # Reconstruct code with spaces: "114005" -> "11 40 05"
        if len(ref_code_norm) == 6:
            ref_code_fmt = f"{ref_code_norm[:2]} {ref_code_norm[2:4]} {ref_code_norm[4:]}"
        elif len(ref_code_norm) == 7:
            ref_code_fmt = f"{ref_code_norm[:2]} {ref_code_norm[2:4]} {ref_code_norm[4:]}"
        else:
            ref_code_fmt = ref_code_norm
        try:
            print(f"[KCSC] cross-ref: fetching {ref_type} {ref_code_fmt}", flush=True)
            ref_name, ref_text, _ = bot.get_content_for_llm(
                ref_code_fmt, doc_type=ref_type, query=req.message, keyword=keyword
            )
            if ref_text.strip():
                trimmed = ref_text[:6000]
                xref_parts.append(f"\n--- 참조 기준: {ref_name} ({ref_type} {ref_code_fmt}) ---\n{trimmed}")
        except Exception as e:
            print(f"[KCSC] cross-ref fetch failed for {ref_type} {ref_code_fmt}: {e}", flush=True)

    if xref_parts:
        xref_content = "\n".join(xref_parts)

    # 4) Build section reference for LLM
    section_ref = "\n".join([
        f"- [[{s['section_id']}|{s['Title']}]]" for s in sections if s["Title"]
    ])

    prompt_parts = [
        f"[{doc_name or code_name} ({target_type} {code})] 기준서 내용:\n{content[:15000]}",
    ]
    if xref_content:
        prompt_parts.append(f"\n교차 참조 기준서 내용:\n{xref_content}")
    prompt_parts.append(f"\n사용 가능한 섹션 목록:\n{section_ref}")
    prompt_parts.append(f"\n질문: {req.message}")
    final_prompt = "\n".join(prompt_parts)

    system_prompt = """당신은 20년 이상 경력의 건설·구조 설계 전문가입니다.
국가건설기준(KDS/KCS)에 정통하며, 후배 엔지니어에게 설계 컨설팅을 해주는 역할입니다.
항상 한국어로, 잘 구조화된 Markdown 형식으로 답변하세요.

## 톤 & 스타일

- **컨설턴트 톤**: "~에 따르면", "설계기준에서는", "실무적으로는" 등 전문가가 조언하는 어투를 사용하세요.
- 단순히 기준서를 읽어주는 것이 아니라, **왜 그런 기준이 있는지**, **실무에서 어떻게 적용하는지** 맥락을 함께 설명하세요.
- 마지막에 "추가로 확인이 필요한 사항이 있으시면 말씀해 주세요" 같은 컨설팅 마무리 멘트를 넣으세요.

## 절대 금지 표현 (이 단어들은 답변에 절대 사용하지 마세요)

"발췌", "제공된 텍스트", "제공된 내용", "첨부하신", "주신 자료", "현재 데이터", "제공 범위", "발췌본", "텍스트에서", "자료에 의하면"
→ 대신 기준서 이름을 직접 언급하세요. 예: "KDS 17 10 00(내진설계 일반)에 따르면..."

## 답변 구조

1. **핵심 결론** (1~2문장, 볼드): 질문에 대한 직접적인 답을 먼저 제시
2. **상세 설명** (## 소제목 활용): 기준값, 조건, 적용 방법을 체계적으로 정리
3. **실무 포인트** (### 실무 적용 시 유의사항): 현장에서 주의할 점이나 팁

## 마크다운 규칙

- 조건별 수치나 비교 항목은 **표(table)**로 정리
- 핵심 기준 원문 인용 시 **> 인용 블록** 사용 (1~2개만, 꼭 필요한 것만)
- 나열 항목은 bullet(-)이나 번호(1.)로 정리
- 근거 섹션 인용은 [[sec-N|섹션 제목]] 형식으로, 문단 끝에 자연스럽게 1~2개만 배치 (남발 금지)
- [그림] 표시가 있으면 "기준서 원문의 해당 그림/도표를 참조하시기 바랍니다"로 안내
- 교차 참조 기준 내용이 제공된 경우, 구체적인 수치/조건을 직접 포함하여 답변"""

    messages_payload = [
        {"role": "system", "content": system_prompt},
    ]
    for m in req.history:
        messages_payload.append({"role": m.get("role", "user"), "content": m.get("content", "")})
    messages_payload.append({"role": "user", "content": final_prompt})

    # 5) Streaming or non-streaming response
    if req.stream:
        def generate():
            import json as _json
            full_answer = ""
            try:
                response = client.chat.completions.create(
                    model=settings.AZURE_OPENAI_DEPLOYMENT_NAME,
                    messages=messages_payload,
                    stream=True,
                )
                for chunk in response:
                    if chunk.choices and chunk.choices[0].delta.content:
                        token = chunk.choices[0].delta.content
                        full_answer += token
                        yield f"data: {_json.dumps({'type': 'token', 'content': token}, ensure_ascii=False)}\n\n"
            except Exception as e:
                yield f"data: {_json.dumps({'type': 'error', 'content': str(e)}, ensure_ascii=False)}\n\n"

            # Parse citations from answer
            citations = _parse_citations(full_answer)

            # Send final metadata
            meta = {
                "type": "done",
                "answer": full_answer,
                "source_code": code,
                "source_name": doc_name or code_name,
                "source_type": target_type,
                "keyword": keyword,
                "sections": [{"section_id": s["section_id"], "Title": s["Title"], "Contents": s["Contents"]} for s in sections],
                "search_candidates": search_candidates,
                "citations": citations,
            }
            yield f"data: {_json.dumps(meta, ensure_ascii=False)}\n\n"

        return StreamingResponse(generate(), media_type="text/event-stream")

    # Non-streaming
    response = client.chat.completions.create(
        model=settings.AZURE_OPENAI_DEPLOYMENT_NAME,
        messages=messages_payload,
    )
    answer = response.choices[0].message.content or ""
    citations = _parse_citations(answer)

    return ChatResponse(
        answer=answer,
        source_code=code,
        source_name=doc_name or code_name,
        source_type=target_type,
        keyword=keyword,
        sections=[SectionItem(**s) for s in sections],
        search_candidates=[SearchCandidate(**c) for c in search_candidates],
        citations=[CitationItem(**c) for c in citations],
    )


def _parse_citations(answer: str) -> List[Dict[str, str]]:
    """Extract [[sec-N|title]] citations from the LLM answer."""
    citations = []
    seen = set()
    for m in re.finditer(r"\[\[(sec-\d+)\|([^\]]+)\]\]", answer):
        sid, title = m.group(1), m.group(2)
        if sid not in seen:
            citations.append({"section_id": sid, "title": title})
            seen.add(sid)
    return citations


# ---------------------------------------------------------------------------
# GET /sections?code=14+20+10&type=KCS
# ---------------------------------------------------------------------------
@router.get("/sections")
async def kcsc_sections(code: str, type: str = "KCS"):
    bot = _get_bot()
    code_name, sections = bot.get_sections_with_ids(code, type)
    if not sections:
        raise HTTPException(status_code=404, detail=f"기준 '{code}' 의 섹션을 찾을 수 없습니다.")
    return {
        "code": code,
        "type": type,
        "name": code_name,
        "sections": sections,
    }
