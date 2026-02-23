"""
P&ID Line List Extraction API
- Receives a P&ID PDF (via blob_path or direct upload)
- Extracts text/layout with Azure Document Intelligence
- Parses line numbers, equipment connections via Azure OpenAI GPT
- Returns structured Line List JSON
- PDF saved to {username}/line/, JSON saved to {username}/json/
"""
import json
import os
import re
import traceback
from typing import Optional
from datetime import datetime, timedelta

from fastapi import APIRouter, HTTPException, Body, Query
from azure.storage.blob import generate_blob_sas, BlobSasPermissions
from app.core.config import settings
from app.services.azure_di import azure_di_service
from app.services.blob_storage import get_container_client, generate_sas_url

router = APIRouter()


@router.get("/upload-sas")
async def get_linelist_upload_sas(filename: str = Query(...), username: str = Query(...)):
    """
    Generate a Write-enabled SAS URL for uploading P&ID PDF to {username}/line/{filename}.
    """
    if not username:
        raise HTTPException(status_code=400, detail="Username is required")

    try:
        blob_name = f"{username}/line/{filename}"

        # Try key-based SAS generation
        if settings.AZURE_BLOB_CONNECTION_STRING and "AccountKey" in settings.AZURE_BLOB_CONNECTION_STRING:
            try:
                parts = dict(item.split('=', 1) for item in settings.AZURE_BLOB_CONNECTION_STRING.split(';') if '=' in item)
                account_name = parts.get("AccountName")
                account_key = parts.get("AccountKey")

                if account_name and account_key:
                    sas_token = generate_blob_sas(
                        account_name=account_name,
                        container_name=settings.AZURE_BLOB_CONTAINER_NAME,
                        blob_name=blob_name,
                        account_key=account_key,
                        permission=BlobSasPermissions(create=True, write=True),
                        expiry=datetime.utcnow() + timedelta(hours=1)
                    )
                    url = f"https://{account_name}.blob.core.windows.net/{settings.AZURE_BLOB_CONTAINER_NAME}/{blob_name}?{sas_token}"
                    return {"upload_url": url, "blob_name": blob_name}
            except Exception as e:
                print(f"[LineList] Key-based SAS failed: {e}, falling back", flush=True)

        # Fallback: env SAS
        write_url = generate_sas_url(blob_name)
        return {"upload_url": write_url, "blob_name": blob_name}

    except Exception as e:
        print(f"[LineList] SAS Gen Failed: {e}", flush=True)
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/files")
def list_linelist_files(username: str = Query(...)):
    """
    List existing P&ID PDFs in {username}/line/ folder.
    Returns files with name, path, size, last_modified.
    """
    try:
        container_client = get_container_client()
        prefix = f"{username}/line/"
        items = []

        for blob in container_client.list_blobs(name_starts_with=prefix):
            filename = blob.name.split('/')[-1]
            if not filename:
                continue
            items.append({
                "name": filename,
                "path": blob.name,
                "size": blob.size,
                "last_modified": blob.last_modified.isoformat() if blob.last_modified else None,
            })

        # Sort by last_modified descending (newest first)
        items.sort(key=lambda x: x.get("last_modified") or "", reverse=True)
        print(f"[LineList] Listed {len(items)} files in {prefix}", flush=True)
        return items

    except Exception as e:
        print(f"[LineList] List error: {e}", flush=True)
        raise HTTPException(status_code=500, detail=str(e))


# GPT system prompt for P&ID line list extraction
LINE_LIST_SYSTEM_PROMPT = """You are an expert P&ID (Piping & Instrumentation Diagram) engineer.
Your task is to extract ALL piping line information from the provided P&ID document text and return a structured JSON array.

## Line Number Format
P&ID line numbers typically follow this pattern:
  [Size]"-[Fluid Code]-[Area/Unit]-[Sequence No.]-[Pipe Spec]-[Insulation Code]
Example: 3"-PYL-21-003001-B2A1-NI
  - NB (Size): 3"
  - Fluid Code: PYL
  - Area: 21
  - No. (Sequence): 003001
  - Pipe Spec: B2A1
  - Insulation: NI

Other common formats:
  [Size]-[Fluid]-[AreaUnit]-[SeqNo]-[Spec]
  Example: 2"-CW-21-001-A1A1

## What to Extract
For each line found in the P&ID:
1. **line_number**: The full line number string as shown on the drawing
2. **nb**: Nominal bore / pipe size (e.g., "3\"", "2\"", "1/2\"")
3. **fluid_code**: Fluid service code (e.g., "PYL", "CW", "ST", "IA")
4. **area**: Area or unit number
5. **seq_no**: Sequence number
6. **pipe_spec**: Piping specification class
7. **insulation**: Insulation code (e.g., "NI"=No Insulation, "HI"=Hot Insulation, "CI"=Cold Insulation)
8. **from_equip**: Source equipment tag or line connection (e.g., "V-2101", "P-2101A/B")
9. **to_equip**: Destination equipment tag or line connection
10. **pid_no**: P&ID drawing number where this line appears
11. **operating_temp**: Operating temperature if found in equipment data blocks
12. **operating_press**: Operating pressure if found in equipment data blocks
13. **design_temp**: Design temperature if found
14. **design_press**: Design pressure if found
15. **remarks**: Any additional notes or remarks

## Rules
- Extract ALL lines visible in the document, not just a few examples.
- If a field cannot be determined, use empty string "".
- Line numbers may appear near flow lines, on leader lines, or in tables.
- Equipment tags typically start with letter codes: V- (Vessel), P- (Pump), E- (Exchanger), T- (Tower), C- (Compressor), etc.
- FROM and TO can also be other line numbers or "OFF-SHEET" references.
- Return ONLY a valid JSON array, no markdown fences, no explanation.

## Output Format
Return a JSON object with a "lines" key containing the array:
{
  "lines": [
    {
      "line_number": "3\"-PYL-21-003001-B2A1-NI",
      "nb": "3\"",
      "fluid_code": "PYL",
      "area": "21",
      "seq_no": "003001",
      "pipe_spec": "B2A1",
      "insulation": "NI",
      "from_equip": "V-2101",
      "to_equip": "P-2101A/B",
      "pid_no": "14780-8120-25-21-0003",
      "operating_temp": "",
      "operating_press": "",
      "design_temp": "",
      "design_press": "",
      "remarks": ""
    }
  ]
}
"""


def _try_load_existing_di_json(container_client, username: str, base_name: str) -> list[dict] | None:
    """
    Try to load existing DI JSON from Azure Blob.
    Checks two formats:
    1. Single file: {username}/json/{base_name}.json (list of pages)
    2. Split format: {username}/json/{base_name}/meta.json + page_N.json
    Returns list of page dicts or None if not found.
    """
    # Format 1: Single JSON file
    single_path = f"{username}/json/{base_name}.json"
    try:
        blob = container_client.get_blob_client(single_path)
        if blob.exists():
            data = json.loads(blob.download_blob().readall())
            if isinstance(data, list) and len(data) > 0:
                print(f"[LineList] Reusing existing DI JSON: {single_path} ({len(data)} pages)", flush=True)
                return data
    except Exception as e:
        print(f"[LineList] Single JSON load failed: {e}", flush=True)

    # Format 2: Split per-page JSON (used by the drawing analysis app)
    meta_path = f"{username}/json/{base_name}/meta.json"
    try:
        meta_blob = container_client.get_blob_client(meta_path)
        if meta_blob.exists():
            meta = json.loads(meta_blob.download_blob().readall())
            total_pages = meta.get("total_pages", 0)
            if total_pages > 0:
                pages = []
                for i in range(1, total_pages + 1):
                    page_path = f"{username}/json/{base_name}/page_{i}.json"
                    page_blob = container_client.get_blob_client(page_path)
                    if page_blob.exists():
                        page_data = json.loads(page_blob.download_blob().readall())
                        pages.append(page_data)
                if pages:
                    print(f"[LineList] Reusing split DI JSON: {meta_path} ({len(pages)} pages)", flush=True)
                    return pages
    except Exception as e:
        print(f"[LineList] Split JSON load failed: {e}", flush=True)

    return None


def _format_tables_markdown(tables: list) -> str:
    """Convert DI table objects into a Markdown string for LLM consumption."""
    md_output = ""
    for i, table in enumerate(tables):
        md_output += f"\nTable {i+1}:\n"

        row_count = table.get("row_count", 0)
        col_count = table.get("column_count", 0)
        cells = table.get("cells", [])

        if not cells:
            continue

        # Reconstruct grid: row_count × col_count
        grid = [["" for _ in range(col_count)] for _ in range(row_count)]

        for cell in cells:
            r, c = cell.get("row_index", 0), cell.get("column_index", 0)
            if r < row_count and c < col_count:
                grid[r][c] = (cell.get("content") or "").replace("\n", " ").strip()

        # Format as Markdown table
        for r_idx, row in enumerate(grid):
            md_output += "| " + " | ".join(row) + " |\n"
            if r_idx == 0:
                md_output += "| " + " | ".join(["---"] * col_count) + " |\n"
        md_output += "\n"

    return md_output


def _call_gpt_for_linelist(page_texts: list[dict]) -> list[dict]:
    """
    Send extracted page texts to Azure OpenAI GPT and get structured line list.
    Includes tables formatted as Markdown for better LLM understanding.
    """
    from openai import AzureOpenAI

    client = AzureOpenAI(
        azure_endpoint=settings.AZURE_OPENAI_ENDPOINT,
        api_key=settings.AZURE_OPENAI_KEY,
        api_version=settings.AZURE_OPENAI_API_VERSION,
    )

    # Build user message with all page contents + tables as Markdown
    user_content_parts = []
    for page in page_texts:
        page_num = page.get("page_number", "?")
        content = page.get("content", "")
        tables = page.get("tables", [])
        pid_no = page.get("도면번호(DWG. NO.)", "")
        title = page.get("도면명(TITLE)", "")

        header = f"=== Page {page_num} ==="
        if pid_no:
            header += f" | Drawing No: {pid_no}"
        if title:
            header += f" | Title: {title}"

        # Combine content + structured tables (like chat.py / azure_search.py pattern)
        page_text = content
        if tables:
            table_md = _format_tables_markdown(tables)
            page_text += f"\n\n[Structured Tables]\n{table_md}"

        user_content_parts.append(f"{header}\n{page_text}")

    user_message = "\n\n".join(user_content_parts)

    print(f"[LineList] Sending {len(page_texts)} pages to GPT ({len(user_message)} chars)", flush=True)

    # Log first 500 chars of user message for debugging
    print(f"[LineList] User message preview: {user_message[:500]}", flush=True)

    response = client.chat.completions.create(
        model=settings.AZURE_OPENAI_DEPLOYMENT_NAME,
        messages=[
            {"role": "system", "content": LINE_LIST_SYSTEM_PROMPT},
            {"role": "user", "content": user_message},
        ],
        temperature=0.1,
        response_format={"type": "json_object"},
    )

    # Debug: log full response metadata
    choice = response.choices[0]
    print(f"[LineList] GPT finish_reason: {choice.finish_reason}", flush=True)
    if choice.message.refusal:
        print(f"[LineList] GPT refusal: {choice.message.refusal}", flush=True)

    raw_response = (choice.message.content or "").strip()
    print(f"[LineList] GPT response length: {len(raw_response)} chars", flush=True)
    if len(raw_response) < 50:
        print(f"[LineList] GPT raw: {raw_response}", flush=True)

    # Parse JSON response (strip markdown fences if present)
    if raw_response.startswith("```"):
        # Remove ```json ... ```
        lines = raw_response.split("\n")
        json_lines = []
        inside = False
        for line in lines:
            if line.strip().startswith("```"):
                inside = not inside
                continue
            if inside:
                json_lines.append(line)
        raw_response = "\n".join(json_lines)

    try:
        result = json.loads(raw_response)
        if isinstance(result, list):
            return result
        elif isinstance(result, dict) and "lines" in result:
            return result["lines"]
        else:
            print(f"[LineList] Unexpected GPT response format: {type(result)}", flush=True)
            return []
    except json.JSONDecodeError as e:
        print(f"[LineList] JSON parse error: {e}", flush=True)
        print(f"[LineList] Raw response: {raw_response[:500]}", flush=True)
        return []


def _normalize_text(s: str) -> str:
    """Remove separators/quotes/spaces for fuzzy OCR matching."""
    return re.sub(r'[-–—""\'\'″`\s.,:;]+', '', s.lower())


def _populate_source_pages(lines: list[dict], di_pages: list[dict]) -> list[dict]:
    """
    Match each line's line_number against DI page data to set:
      - source_page: page number
      - source_polygon: DI polygon coordinates [x1,y1,...,x8,y8]
      - source_layout_width / source_layout_height: page dimensions for coord transform
    """
    for line in lines:
        line_num = (line.get("line_number") or "").strip()
        if not line_num:
            continue

        normalized_search = _normalize_text(line_num)
        seq_match = re.search(r'\d{4,}', line_num)
        seq_num = seq_match.group(0) if seq_match else None
        parts = [p for p in re.split(r'[-"\'\s]+', line_num.lower()) if len(p) > 1]

        for page_data in di_pages:
            page_num = page_data.get("page_number", 0)
            normalized_content = _normalize_text(page_data.get("content") or "")

            if normalized_search not in normalized_content:
                continue

            line["source_page"] = str(page_num)

            # --- Find polygon coordinates ---
            layout = page_data.get("layout", {})
            ocr_lines = layout.get("lines", [])
            ocr_words = layout.get("words", [])
            page_w = layout.get("width", 0)
            page_h = layout.get("height", 0)

            polygon = None

            # 1) OCR lines: full line number match (normalized)
            best_line, best_ratio = None, 0
            for ol in ocr_lines:
                nc = _normalize_text(ol.get("content", ""))
                if normalized_search in nc and ol.get("polygon"):
                    ratio = len(normalized_search) / max(len(nc), 1)
                    if ratio > best_ratio:
                        best_ratio = ratio
                        best_line = ol
            if best_line:
                polygon = best_line["polygon"]

            # 2) OCR words: full line number match
            if not polygon:
                for w in ocr_words:
                    nc = _normalize_text(w.get("content", ""))
                    if normalized_search in nc and w.get("polygon"):
                        polygon = w["polygon"]
                        break

            # 3) OCR lines: sequence number + context overlap
            if not polygon and seq_num:
                best_sl, best_overlap = None, 0
                for ol in ocr_lines:
                    lc = (ol.get("content") or "").lower()
                    if seq_num in lc and ol.get("polygon"):
                        overlap = sum(1 for p in parts if p in lc)
                        if overlap > best_overlap:
                            best_overlap = overlap
                            best_sl = ol
                if best_sl:
                    polygon = best_sl["polygon"]

            # 4) OCR words: sequence number (last resort)
            if not polygon and seq_num:
                for w in ocr_words:
                    wc = (w.get("content") or "").strip()
                    if seq_num in wc and w.get("polygon"):
                        polygon = w["polygon"]
                        break

            if polygon:
                line["source_polygon"] = polygon
                line["source_layout_width"] = page_w
                line["source_layout_height"] = page_h
                print(f"[LineList] Polygon found for {line_num} on page {page_num}", flush=True)

            break  # Found page, stop

    return lines


@router.post("/extract")
async def extract_linelist(
    blob_path: str = Body(...),
    username: Optional[str] = Body(None),
):
    """
    Extract P&ID Line List from a PDF already uploaded to Azure Blob.
    Frontend uploads via /upload-sas first, then calls this with blob_path.

    Returns: { "lines": [...], "page_count": N, "pid_numbers": [...] }
    """
    try:
        container_client = get_container_client()

        pdf_filename = blob_path.split('/')[-1]
        base_name = os.path.splitext(pdf_filename)[0] if pdf_filename else ""
        print(f"[LineList] Analyzing blob: {blob_path}", flush=True)
        blob_client = container_client.get_blob_client(blob_path)
        if not blob_client.exists():
            raise HTTPException(status_code=404, detail=f"Blob not found: {blob_path}")

        # Try to reuse existing DI JSON from {username}/json/
        di_pages = None
        if username and base_name:
            di_pages = _try_load_existing_di_json(container_client, username, base_name)

        # If no cached JSON, run Document Intelligence
        if not di_pages:
            sas_url = generate_sas_url(blob_path)
            di_pages = azure_di_service.analyze_document_from_url(sas_url)

            if not di_pages:
                raise HTTPException(status_code=500, detail="Document Intelligence returned no data")

            print(f"[LineList] DI extracted {len(di_pages)} pages", flush=True)

            # Save DI result JSON to {username}/json/{filename}.json (for LLM reuse)
            if pdf_filename:
                di_json_blob_name = f"{username}/json/{base_name}.json" if username else f"json/{base_name}.json"
                try:
                    di_json_content = json.dumps(di_pages, ensure_ascii=False, indent=2)
                    di_json_blob = container_client.get_blob_client(di_json_blob_name)
                    di_json_blob.upload_blob(di_json_content, overwrite=True)
                    print(f"[LineList] DI JSON saved to: {di_json_blob_name}", flush=True)
                except Exception as je:
                    print(f"[LineList] Warning: DI JSON save failed: {je}", flush=True)

        # Collect unique P&ID numbers
        pid_numbers = set()
        for page in di_pages:
            pid = page.get("도면번호(DWG. NO.)", "")
            if pid and pid != "REV.":
                pid_numbers.add(pid)

        # Send to GPT for structured extraction
        lines = _call_gpt_for_linelist(di_pages)
        lines = _populate_source_pages(lines, di_pages)

        print(f"[LineList] Extracted {len(lines)} lines from {len(di_pages)} pages", flush=True)

        # Save result JSON to {username}/json/{filename}_linelist.json
        json_saved_path = None
        if pdf_filename and lines:
            base_name = os.path.splitext(pdf_filename)[0]
            json_blob_name = f"{username}/json/{base_name}_linelist.json" if username else f"json/{base_name}_linelist.json"
            try:
                result_data = {
                    "lines": lines,
                    "page_count": len(di_pages),
                    "pid_numbers": list(pid_numbers),
                    "source_file": pdf_filename,
                }
                json_content = json.dumps(result_data, ensure_ascii=False, indent=2)
                json_blob_client = container_client.get_blob_client(json_blob_name)
                json_blob_client.upload_blob(json_content, overwrite=True)
                json_saved_path = json_blob_name
                print(f"[LineList] JSON saved to: {json_blob_name}", flush=True)
            except Exception as je:
                print(f"[LineList] Warning: JSON save failed: {je}", flush=True)

        return {
            "lines": lines,
            "page_count": len(di_pages),
            "pid_numbers": list(pid_numbers),
            "json_path": json_saved_path,
        }

    except HTTPException:
        raise
    except Exception as e:
        print(f"[LineList] Error: {e}", flush=True)
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/extract-pages")
async def extract_linelist_pages(
    blob_path: str = Body(...),
    pages: str = Body(None),
    username: Optional[str] = Body(None),
):
    """
    Extract Line List from specific pages of a P&ID PDF.
    Useful for large PDFs - process page ranges independently.

    Args:
        blob_path: Azure blob path to the PDF
        pages: Page range string (e.g. "1-5", "3,5,7")
        username: Optional user scope
    """
    try:
        container_client = get_container_client()
        blob_client = container_client.get_blob_client(blob_path)
        if not blob_client.exists():
            raise HTTPException(status_code=404, detail=f"Blob not found: {blob_path}")

        sas_url = generate_sas_url(blob_path)
        print(f"[LineList] Analyzing pages={pages} of {blob_path}", flush=True)

        di_pages = azure_di_service.analyze_document_from_url(sas_url, pages=pages)

        if not di_pages:
            return {"lines": [], "page_count": 0, "pid_numbers": []}

        # Save DI result per page-range to {username}/json/{filename}_pages_{range}.json
        pdf_filename = blob_path.split('/')[-1]
        base_name = os.path.splitext(pdf_filename)[0]
        safe_pages = (pages or "all").replace(",", "_")
        di_json_blob_name = f"{username}/json/{base_name}_pages_{safe_pages}.json" if username else f"json/{base_name}_pages_{safe_pages}.json"
        try:
            di_json_content = json.dumps(di_pages, ensure_ascii=False, indent=2)
            container_client.get_blob_client(di_json_blob_name).upload_blob(di_json_content, overwrite=True)
            print(f"[LineList] DI JSON saved: {di_json_blob_name}", flush=True)
        except Exception as je:
            print(f"[LineList] Warning: DI JSON save failed: {je}", flush=True)

        pid_numbers = set()
        for page in di_pages:
            pid = page.get("도면번호(DWG. NO.)", "")
            if pid and pid != "REV.":
                pid_numbers.add(pid)

        lines = _call_gpt_for_linelist(di_pages)
        lines = _populate_source_pages(lines, di_pages)

        print(f"[LineList] Pages {pages}: {len(lines)} lines extracted", flush=True)

        return {
            "lines": lines,
            "page_count": len(di_pages),
            "pid_numbers": list(pid_numbers),
        }

    except HTTPException:
        raise
    except Exception as e:
        print(f"[LineList] Error: {e}", flush=True)
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/di-ocr")
async def get_di_ocr(blob_path: str = Query(...), username: str = Query(...)):
    """
    Return cached Document Intelligence OCR data (with coordinates) for highlighting.
    Tries: full JSON → split format → per-range page JSONs.
    """
    container_client = get_container_client()
    pdf_filename = blob_path.split('/')[-1]
    base_name = os.path.splitext(pdf_filename)[0]

    # Try full / split DI JSON first
    di_pages = _try_load_existing_di_json(container_client, username, base_name)

    # Fallback: merge per-range page JSONs (from chunked extraction)
    if not di_pages:
        prefix = f"{username}/json/{base_name}_pages_"
        try:
            all_pages = []
            seen_page_nums = set()
            for blob in container_client.list_blobs(name_starts_with=prefix):
                if blob.name.endswith(".json"):
                    data = json.loads(container_client.get_blob_client(blob.name).download_blob().readall())
                    if isinstance(data, list):
                        for p in data:
                            pn = p.get("page_number", 0)
                            if pn not in seen_page_nums:
                                seen_page_nums.add(pn)
                                all_pages.append(p)
            if all_pages:
                all_pages.sort(key=lambda p: p.get("page_number", 0))
                di_pages = all_pages
                print(f"[LineList] Merged {len(di_pages)} pages from per-range JSONs", flush=True)
        except Exception as e:
            print(f"[LineList] Per-range JSON merge failed: {e}", flush=True)

    if not di_pages:
        raise HTTPException(status_code=404, detail="No cached OCR data")
    return {"pages": di_pages}
