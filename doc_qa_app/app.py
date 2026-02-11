import streamlit as st
import os
import sys
import time
import uuid
import urllib.parse
import re
import requests
import fitz  # PyMuPDF
from datetime import datetime, timedelta
from azure.storage.blob import BlobServiceClient, generate_blob_sas, BlobSasPermissions, generate_container_sas, ContainerSasPermissions
from azure.core.credentials import AzureKeyCredential

# Add parent directory to sys.path to allow importing modules from root
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

# Local Imports
from search_manager import AzureSearchManager
from chat_manager_v2 import AzureOpenAIChatManager
from utils.auth_manager import AuthManager
from modules.login_page import render_login_page
from utils.chat_history_utils import load_history, save_history, get_session_title
import extra_streamlit_components as stx

# -----------------------------
# 설정 및 비밀 관리
# -----------------------------
st.set_page_config(page_title="물어보면 답하는 문서 AI", page_icon="🤖", layout="wide")

# Custom CSS
st.markdown("""
<style>
    /* Increase font size for tab labels */
    button[data-baseweb="tab"] {
        font-size: 20px !important;
    }
    button[data-baseweb="tab"] p {
        font-size: 20px !important;
        font-weight: 600 !important;
    }
    
    /* Document list - row alignment */
    [data-testid="stHorizontalBlock"] {
        display: flex !important;
        align-items: center !important;
        gap: 0.5rem !important;
        min-height: 42px !important;
    }
    
    /* Callout / Info Box Styling */
    .stAlert {
        padding: 0.5rem 1rem !important;
    }
    
    /* Make chat messages look better */
    .stChatMessage {
        background-color: #f0f2f6; 
        border-radius: 10px;
        padding: 10px;
        margin-bottom: 10px;
    }
    [data-testid="stChatMessageContent"] {
        background-color: transparent !important;
    }
    
    /* All buttons - consistent height */
    .stButton button {
        min-height: 38px !important;
    }
</style>
""", unsafe_allow_html=True)

def get_secret(key):
    if key in st.secrets:
        return st.secrets[key]
    return os.environ.get(key)

# Essential Credentials
STORAGE_CONN_STR = get_secret("AZURE_STORAGE_CONNECTION_STRING")
CONTAINER_NAME = get_secret("AZURE_BLOB_CONTAINER_NAME") or "blob-leesunguk"

SEARCH_ENDPOINT = get_secret("AZURE_SEARCH_ENDPOINT")
SEARCH_KEY = get_secret("AZURE_SEARCH_KEY")
SEARCH_INDEX_NAME = get_secret("AZURE_SEARCH_INDEX_NAME") or "pdf-search-index"

AZURE_OPENAI_ENDPOINT = get_secret("AZURE_OPENAI_ENDPOINT")
AZURE_OPENAI_KEY = get_secret("AZURE_OPENAI_KEY")
AZURE_OPENAI_DEPLOYMENT = get_secret("AZURE_OPENAI_DEPLOYMENT") or get_secret("AZURE_OPENAI_DEPLOYMENT_NAME")
AZURE_OPENAI_API_VERSION = get_secret("AZURE_OPENAI_API_VERSION")

# -----------------------------
# Azure Client Helpers
# -----------------------------
def get_blob_service_client():
    if not STORAGE_CONN_STR:
        st.error("Azure Storage Connection String is not set.")
        st.stop()
    return BlobServiceClient.from_connection_string(STORAGE_CONN_STR)

def get_search_manager():
    if not SEARCH_ENDPOINT or not SEARCH_KEY:
        st.error("Azure Search Endpoint or Key is not set.")
        st.stop()
    return AzureSearchManager(SEARCH_ENDPOINT, SEARCH_KEY, SEARCH_INDEX_NAME)

def get_chat_manager():
    if not AZURE_OPENAI_ENDPOINT or not AZURE_OPENAI_KEY:
        st.error("Azure OpenAI Endpoint or Key is not set.")
        st.stop()
    return AzureOpenAIChatManager(
        AZURE_OPENAI_ENDPOINT, 
        AZURE_OPENAI_KEY, 
        AZURE_OPENAI_DEPLOYMENT, 
        AZURE_OPENAI_API_VERSION,
        get_search_manager(),
        STORAGE_CONN_STR,
        CONTAINER_NAME
    )

def generate_sas_url(blob_service_client, container_name, blob_name=None, page=None, permission="r", expiry_hours=1):
    try:
        account_name = blob_service_client.account_name
        if hasattr(blob_service_client.credential, 'account_key'):
            account_key = blob_service_client.credential.account_key
        else:
            account_key = blob_service_client.credential['account_key']
        
        start = datetime.utcnow() - timedelta(minutes=15)
        expiry = datetime.utcnow() + timedelta(hours=expiry_hours)
        
        if blob_name:
            import re
            clean_name = re.sub(r'\s*\(\s*p\.?\s*\d+\s*\)', '', blob_name).strip()
            
            import mimetypes
            content_type, _ = mimetypes.guess_type(clean_name)
            if clean_name.lower().endswith('.pdf'):
                content_type = "application/pdf"
            elif not content_type:
                content_type = "application/octet-stream"

            sas_token = generate_blob_sas(
                account_name=account_name,
                container_name=container_name,
                blob_name=clean_name,
                account_key=account_key,
                permission=BlobSasPermissions(read=True),
                start=start,
                expiry=expiry,
                content_disposition="inline",
                content_type=content_type
            )
            sas_url = f"https://{account_name}.blob.core.windows.net/{container_name}/{urllib.parse.quote(clean_name, safe='/')}?{sas_token}"
            
            if clean_name.lower().endswith('.pdf'):
                final_url = sas_url
                if page:
                    final_url += f"#page={page}"
                return final_url
            else:
                return sas_url
        return "#"
            
    except Exception as e:
        # st.error(f"Error generating SAS URL ({blob_name}): {e}")
        return "#"

def is_drm_protected(uploaded_file):
    try:
        file_type = uploaded_file.name.split('.')[-1].lower()
        if file_type == 'pdf':
            try:
                bytes_data = uploaded_file.getvalue()
                with fitz.open(stream=bytes_data, filetype="pdf") as doc:
                    if doc.is_encrypted:
                        return True
            except:
                return True 
        return False
    except:
        return False

# -----------------------------
# Auth & User Setup
# -----------------------------
auth_manager = AuthManager(STORAGE_CONN_STR)
cookie_manager = stx.CookieManager(key="auth_cookie_manager_doc_app")

if 'is_logged_in' not in st.session_state:
    st.session_state.is_logged_in = False

if not st.session_state.is_logged_in:
    # Auto-login check
    try:
        time.sleep(0.1)
        auth_email = cookie_manager.get(cookie="auth_email")
        if auth_email:
            user = auth_manager.get_user_by_email(auth_email)
            if user:
                st.session_state.is_logged_in = True
                st.session_state.user_info = user
                st.toast(f"자동 로그인되었습니다: {user.get('name')}")
                st.rerun()
    except Exception:
        pass

if not st.session_state.is_logged_in:
    render_login_page(auth_manager, cookie_manager)
    st.stop()

user_info = st.session_state.get('user_info', {})
user_role = user_info.get('role', 'guest')
def get_user_folder_name(user_info):
    if not user_info: return "guest"
    return user_info.get('name', user_info.get('id', 'guest')).strip()

user_folder = get_user_folder_name(user_info)

# -----------------------------
# Main Application Logic
# -----------------------------
SEARCH_HISTORY_FILE = "search_chat_history.json"
CURRENT_HISTORY_FILE = SEARCH_HISTORY_FILE

# Initialize Session State
if "search_chat_history_data" not in st.session_state:
    # Try to load from parent dir first to share history
    root_history_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), SEARCH_HISTORY_FILE)
    if os.path.exists(root_history_path):
        try:
            st.session_state.search_chat_history_data = load_history(root_history_path)
            CURRENT_HISTORY_FILE = root_history_path
        except:
             st.session_state.search_chat_history_data = load_history(SEARCH_HISTORY_FILE)
    else:
        st.session_state.search_chat_history_data = load_history(SEARCH_HISTORY_FILE)

if "current_search_session_id" not in st.session_state:
    new_id = str(uuid.uuid4())
    st.session_state.current_search_session_id = new_id
    st.session_state.search_chat_history_data[new_id] = {
        "title": "새로운 대화",
        "timestamp": datetime.now().isoformat(),
        "messages": []
    }
    st.session_state.chat_messages = []

# Layout
col_history, col_spacer, col_main = st.columns([0.2, 0.05, 0.75])

# --- Content (Right Side) First for flow ---
with col_main:
    st.title("물어보면 답하는 문서 AI")
    
    tab1, tab2, tab3 = st.tabs(["📤 문서 등록", "🔎 키워드 검색", "🤖 AI 질의응답"])
    
    # --- Tab 1: Upload ---
    with tab1:
        if "doc_search_uploader_key" not in st.session_state:
            st.session_state.doc_search_uploader_key = 0
            
        doc_upload = st.file_uploader("문서를 등록하면 검색과 질의응답이 가능합니다.", type=['pdf', 'docx', 'txt', 'pptx'], key=f"doc_search_upload_{st.session_state.doc_search_uploader_key}")
        
        if doc_upload:
            if is_drm_protected(doc_upload):
                st.error("⛔ DRM으로 보호된 파일은 업로드할 수 없습니다.")
            elif st.button("업로드", key="btn_doc_upload"):
                try:
                    blob_service_client = get_blob_service_client()
                    container_client = blob_service_client.get_container_client(CONTAINER_NAME)
                    blob_name = f"{user_folder}/my-documents/{doc_upload.name}"
                    blob_client = container_client.get_blob_client(blob_name)
                    blob_client.upload_blob(doc_upload, overwrite=True)
                    st.success(f"'{doc_upload.name}' 업로드 완료! (인덱싱에 시간이 걸릴 수 있습니다)")
                except Exception as e:
                    st.error(f"업로드 실패: {e}")

        st.divider()
        st.markdown("### 🗂️ 등록 문서 목록")
        if st.button("목록 새로고침"):
            st.rerun()

        try:
            search_manager = get_search_manager()
            account_name = get_blob_service_client().account_name
            encoded_user_folder = urllib.parse.quote(user_folder)
            prefix_url = f"https://{account_name}.blob.core.windows.net/{CONTAINER_NAME}/{encoded_user_folder}/"
            
            if user_role == 'admin':
                filter_expr = None
            else:
                upper_bound = prefix_url[:-1] + '0'
                filter_expr = f"metadata_storage_path ge '{prefix_url}' and metadata_storage_path lt '{upper_bound}'"
            
            results = search_manager.search("*", filter_expr=filter_expr, top=1000)
            filtered_results = [res for res in results if not res.get('metadata_storage_name', '').lower().endswith('.json')]
            
            if not filtered_results:
                st.info("인덱싱된 문서가 없습니다.")
            else:
                st.write(f"총 {len(filtered_results)}개 문서가 등록되어 있습니다.")
                doc_data = []
                for res in filtered_results:
                    file_name = res.get('metadata_storage_name', 'Unknown')
                    size = res.get('metadata_storage_size', 0)
                    last_modified = res.get('metadata_storage_last_modified', '')
                    size_mb = f"{int(size) / (1024 * 1024):.2f} MB"
                    try:
                        dt = datetime.fromisoformat(last_modified.replace('Z', '+00:00'))
                        date_str = dt.strftime("%Y-%m-%d %H:%M")
                    except:
                        date_str = last_modified
                    doc_data.append({"Name": file_name, "Size": size_mb, "Last Modified": date_str})
                
                st.dataframe(doc_data, use_container_width=True, hide_index=True)

        except Exception as e:
            st.error(f"문서 목록 로드 실패: {e}")

    # --- Tab 2: Keyword Search ---
    with tab2:
        with st.expander("⚙️ 고급 검색 옵션", expanded=False):
            c1, c2 = st.columns(2)
            with c1:
                search_use_semantic = st.checkbox("시맨틱 랭커 사용", value=True, key="search_use_semantic")
            with c2:
                search_mode_opt = st.radio("검색 모드", ["all (AND)", "any (OR)"], index=1, horizontal=True, key="search_mode_opt")
                search_mode = "all" if "all" in search_mode_opt else "any"

        if query := st.text_input("검색할 키워드를 입력하세요...", key="keyword_input"):
            with st.spinner("검색 중..."):
                try:
                    search_manager = get_search_manager()
                    account_name = get_blob_service_client().account_name
                    encoded_user_folder = urllib.parse.quote(user_folder)
                    prefix_url = f"https://{account_name}.blob.core.windows.net/{CONTAINER_NAME}/{encoded_user_folder}/"
                    
                    if user_role == 'admin':
                        filter_expr = None
                    else:
                        upper_bound = prefix_url[:-1] + '0'
                        filter_expr = f"metadata_storage_path ge '{prefix_url}' and metadata_storage_path lt '{upper_bound}'"
                    
                    results = search_manager.search(query, filter_expr=filter_expr, use_semantic_ranker=search_use_semantic, search_mode=search_mode)
                    filtered_results = [res for res in results if not res.get('metadata_storage_name', '').lower().endswith('.json')]
                    
                    st.success(f"총 {len(filtered_results)}개의 문서를 찾았습니다.")
                    
                    for result in filtered_results:
                        with st.container():
                            file_name = result.get('metadata_storage_name', 'Unknown File')
                            path = result.get('metadata_storage_path', '')
                            
                            highlights = result.get('@search.highlights')
                            content_snippet = ""
                            if highlights:
                                snippets = highlights.get('content', []) + highlights.get('content_exact', [])
                                content_snippet = " ... ".join(list(set(snippets))[:3])
                            else:
                                content_snippet = result.get('content', '')[:300] + "..."
                            
                            st.markdown(f"### 📄 {file_name}")
                            st.markdown(f"> {content_snippet}", unsafe_allow_html=True)
                            
                            # SAS Link Generation
                            try:
                                blob_service_client = get_blob_service_client()
                                from urllib.parse import unquote
                                if "https://direct_fetch/" in path:
                                    blob_path = unquote(path.replace("https://direct_fetch/", "").split('#')[0])
                                elif CONTAINER_NAME in path:
                                    blob_path = unquote(path.split(f"/{CONTAINER_NAME}/")[1].split('#')[0])
                                else:
                                    blob_path = path
                                    
                                sas_url = generate_sas_url(blob_service_client, CONTAINER_NAME, blob_path)
                                st.markdown(f"[문서 열기]({sas_url})")
                            except Exception as e:
                                st.caption(f"링크 생성 실패: {e}")
                            st.divider()
                            
                except Exception as e:
                    st.error(f"검색 오류: {e}")

    # --- Tab 3: AI Chat ---
    with tab3:
        with st.expander("⚙️ 고급 검색 옵션 (RAG 설정)", expanded=False):
            c1, c2 = st.columns(2)
            with c1:
                chat_use_semantic = st.checkbox("시맨틱 랭커 사용", value=True, key="chat_use_semantic")
            with c2:
                chat_search_mode_opt = st.radio("검색 모드", ["all (AND)", "any (OR)"], index=1, horizontal=True, key="chat_search_mode")
                chat_search_mode = "all" if "all" in chat_search_mode_opt else "any"

        # Check for chat messages
        if "chat_messages" not in st.session_state:
            st.session_state.chat_messages = []

        for message in st.session_state.chat_messages:
            with st.chat_message(message["role"]):
                st.markdown(message["content"], unsafe_allow_html=True)
                if "citations" in message and message["citations"]:
                    st.markdown("---")
                    st.caption("📚 **참조 문서:**")
                    for i, citation in enumerate(message["citations"], 1):
                        filepath = citation.get('filepath', 'Unknown')
                        display_url = citation.get('final_url', '#')
                        st.markdown(f"{i}. [{os.path.basename(filepath)}]({display_url})")

        if prompt := st.chat_input("질문을 입력하세요...", key="search_chat_input"):
            st.session_state.chat_messages.append({"role": "user", "content": prompt})
            with st.chat_message("user"):
                st.markdown(prompt)

            with st.chat_message("assistant"):
                with st.spinner("답변 생성 중..."):
                    try:
                        chat_manager = get_chat_manager()
                        conversation_history = [
                            {"role": msg["role"], "content": msg["content"]}
                            for msg in st.session_state.chat_messages[:-1]
                        ]
                        
                        response_text, citations, context, final_filter, search_results = chat_manager.get_chat_response(
                            prompt, 
                            conversation_history, 
                            search_mode=chat_search_mode, 
                            use_semantic_ranker=chat_use_semantic,
                            filter_expr=None,
                            user_folder=user_folder,
                            is_admin=(user_role == 'admin')
                        )
                        
                        # --- Process Citation Links ---
                        citation_links = {}
                        processed_citations = []
                        
                        if citations:
                            for cit in citations:
                                filepath = cit.get('filepath', 'Unknown')
                                clean_filepath = re.sub(r'\s*\(\s*p\.?\s*\d+\s*\)', '', filepath).strip()
                                page = cit.get('page')
                                
                                try:
                                    final_url = generate_sas_url(
                                        get_blob_service_client(), CONTAINER_NAME, clean_filepath, page=page
                                    )
                                    cit['final_url'] = final_url
                                    processed_citations.append(cit)
                                    
                                    filename = os.path.basename(filepath)
                                    if page:
                                        citation_links[(filename, str(page))] = final_url
                                except:
                                    pass

                        # Inline Link Replacement
                        if response_text:
                            pattern = r'[\[\(]([^\[\]|]+?:\s*p\.?\s*(\d+))[\]\)]'
                            
                            def replace_citation(match):
                                content = match.group(1).strip()
                                content = re.sub(r'^문서명\s*:\s*', '', content)
                                
                                if ':' in content:
                                    fname = content.rsplit(':', 1)[0].strip()
                                    p_num = match.group(2)
                                else:
                                    return match.group(0)
                                    
                                original_text = match.group(0)
                                target_url = None
                                clean_llm = re.sub(r'\.pdf$', '', fname.lower().strip())
                                matched_filename = None
                                
                                for (k_fname, k_page), url in citation_links.items():
                                    clean_known = re.sub(r'\.pdf$', '', k_fname.lower().strip())
                                    clean_known = re.sub(r'\s*\(\s*p\.?\s*\d+\s*\)', '', clean_known).strip()
                                    
                                    if not clean_known: continue
                                    
                                    if str(k_page) == str(p_num):
                                        if clean_llm == clean_known or clean_llm in clean_known or clean_known in clean_llm:
                                            target_url = url
                                            matched_filename = k_fname
                                            break
                                
                                if target_url:
                                    safe_url = target_url.replace('(', '%28').replace(')', '%29')
                                    if matched_filename:
                                        new_text = f"({matched_filename}: p.{p_num})"
                                        return f"**[{new_text}]({safe_url})**"
                                    return f"**[{original_text}]({safe_url})**"
                                return original_text
                            
                            response_text = re.sub(pattern, replace_citation, response_text)
                            response_text = response_text.replace('~', '\\~')

                        st.markdown(response_text, unsafe_allow_html=True)
                        
                        if processed_citations:
                            st.markdown("---")
                            st.caption("📚 **참조 문서:**")
                            for i, citation in enumerate(processed_citations, 1):
                                filepath = citation.get('filepath', 'Unknown')
                                display_url = citation.get('final_url', '#')
                                st.markdown(f"{i}. [{os.path.basename(filepath)}]({display_url})")
                        
                        st.session_state.chat_messages.append({
                            "role": "assistant",
                            "content": response_text,
                            "citations": processed_citations,
                            "context": context
                        })
                        
                        # Save History
                        current_id = st.session_state.current_search_session_id
                        current_title = st.session_state.search_chat_history_data[current_id]["title"]
                        if current_title == "새로운 대화":
                            new_title = get_session_title(st.session_state.chat_messages)
                            st.session_state.search_chat_history_data[current_id]["title"] = new_title
                        
                        st.session_state.search_chat_history_data[current_id]["messages"] = st.session_state.chat_messages
                        st.session_state.search_chat_history_data[current_id]["timestamp"] = datetime.now().isoformat()
                        save_history(CURRENT_HISTORY_FILE, st.session_state.search_chat_history_data)
                        
                        st.rerun()
                        
                    except Exception as e:
                        st.error(f"오류가 발생했습니다: {str(e)}")

# --- Left Sidebar (History) ---
with col_history:
    st.markdown("### 채팅 기록")
    if st.button("➕ 새 채팅", key="new_search_chat", use_container_width=True):
        new_id = str(uuid.uuid4())
        st.session_state.current_search_session_id = new_id
        st.session_state.search_chat_history_data[new_id] = {
            "title": "새로운 대화",
            "timestamp": datetime.now().isoformat(),
            "messages": []
        }
        st.session_state.chat_messages = []
        st.rerun()

    st.markdown("---")
    sorted_sessions = sorted(
        st.session_state.search_chat_history_data.items(),
        key=lambda x: x[1].get("timestamp", ""),
        reverse=True
    )
    
    for session_id, session_data in sorted_sessions:
        title = session_data.get("title", "대화")
        if session_id == st.session_state.current_search_session_id:
            st.button(f"📂 {title}", key=f"hist_{session_id}", use_container_width=True, type="primary")
        else:
            if st.button(f"📄 {title}", key=f"hist_{session_id}", use_container_width=True):
                st.session_state.current_search_session_id = session_id
        st.session_state.chat_messages = st.session_state.search_chat_history_data[st.session_state.current_search_session_id].get("messages", [])

    if st.button("🗑️ 기록 삭제", key="del_hist", use_container_width=True):
        st.session_state.search_chat_history_data = {}
        save_history(CURRENT_HISTORY_FILE, {})
        new_id = str(uuid.uuid4())
        st.session_state.current_search_session_id = new_id
        st.session_state.search_chat_history_data[new_id] = {
            "title": "새로운 대화",
            "timestamp": datetime.now().isoformat(),
            "messages": []
        }
        st.session_state.chat_messages = []
        st.rerun()
