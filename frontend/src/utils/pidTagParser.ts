/**
 * P&ID OCR Tag Parser
 *
 * Azure Document Intelligence가 추출한 파편화된 텍스트 배열을
 * EPC 설계자의 검색 의도(Search Intent)에 맞게 3가지 카테고리로 분류합니다.
 *
 * 알고리즘 (4-Pass, 순서 중요):
 *   Pass 1: 라인넘버 — 하이픈 2개 이상 + 숫자 포함 (가장 구별력 높음)
 *   Pass 2: 완성형 태그 — 단일 워드 내 PREFIX-NUMBER 패턴
 *   Pass 3: 인접 머지 — PREFIX + TAG_NUMBER를 2-word lookahead로 결합
 *   Pass 4: 스펙 — 스펙코드, 인치규격, 숫자+단위 결합
 *   나머지: 노이즈로 버림 (SET, NOTE, @, 단독 숫자 등)
 */

export interface ParsedPidTags {
  equipment: string[];  // 기기/계기 태그: PSV-0905A, TIC-101
  lines: string[];      // 배관 라인 넘버: 4"-PL-21-009013-B2A1-H
  specs: string[];      // 주요 스펙/수치: 39.9 kg/cm2g, 1.5F2
}

// ── Known EPC Instrument/Equipment Prefixes (90+) ──
// 화이트리스트 기반으로 오탐(false positive) 최소화
const KNOWN_PREFIXES = new Set([
  // Pressure
  'PT', 'PI', 'PIC', 'PIT', 'PDI', 'PDIC', 'PAH', 'PAL', 'PAHH', 'PALL',
  'PSV', 'PRV', 'PSE', 'PSH', 'PSL', 'PSHH', 'PSLL', 'PG', 'PB',
  // Temperature
  'TI', 'TIC', 'TIT', 'TE', 'TT', 'TAH', 'TAL', 'TAHH', 'TALL',
  'TSH', 'TSL', 'TSHH', 'TSLL', 'TW', 'TG',
  // Flow
  'FI', 'FIC', 'FIT', 'FE', 'FT', 'FAH', 'FAL', 'FSH', 'FSL', 'FQ', 'FO',
  // Level
  'LI', 'LIC', 'LIT', 'LE', 'LT', 'LAH', 'LAL', 'LAHH', 'LALL',
  'LSH', 'LSL', 'LSHH', 'LSLL', 'LG', 'LB',
  // Analytical
  'AI', 'AIC', 'AIT', 'AE', 'AT',
  // Valves
  'XV', 'HV', 'PCV', 'TCV', 'FCV', 'LCV',
  'SDV', 'BDV', 'MOV', 'SOV', 'AOV',
  'CV', 'RV', 'BV', 'SV', 'NRV', 'GOV',
  // Position / Switch
  'ZSO', 'ZSC', 'ZI', 'ZT', 'ZA',
  'HS', 'HC', 'HIC',
  // Equipment (2+ char)
  'HX', 'EX', 'ST', 'TK', 'VV', 'DR', 'PP',
  'AG', 'BL', 'CL', 'CR', 'EJ', 'FL',
  // Piping — line service codes often used as tag prefix
  'PL', 'CW', 'SW', 'FW', 'IA', 'PA', 'NG', 'FG', 'LP', 'HP', 'MP',
]);

// ── EPC 표준 단위 패턴 ──
// 숫자 뒤에 오면 스펙으로 인식
const UNIT_RE = /^(kg\/cm2g?|barg?|bara|bar|mmHg|mmH2O|mmWC|mbar|MPa|kPa|Pa|psi[ag]?|atm|mm|cm|m|in|ft|°[CF]|℃|℉|kg|ton|lb|g|m3\/h|m3\/hr|l\/min|LPM|GPM|SCFM|ACFM|Nm3\/h|Nm3\/hr|Hz|RPM|kW|HP|MW|kVA|NPS|DN|SCH|Sch|BWG|NB|m\/s|m\/sec|ft\/s|cP|cSt|API|ANSI|PN)$/i;

// ── Regex Helpers ──
const PREFIX_RE = /^[A-Z]{2,5}$/;
const TAG_NUM_RE = /^\d+[A-Z0-9]*$/;                    // 0905A, 101, 2001B
const COMPLETE_TAG_RE = /^[A-Z]{2,5}-?\d+[A-Z0-9]*$/;    // PSV0905A or PSV-0905A (single word)
const NUMERIC_RE = /^\d+\.?\d*$/;                         // 39.9, 150
const SPEC_CODE_RE = /^\d+\.?\d*[A-Z][A-Z0-9]*$/;       // 1.5F2, 3R12
const INCH_SPEC_RE = /^\d+[""\u2033\u201C\u201D]/;       // 44", 4"PYLO (various quote chars)
const TRAILING_JUNK_RE = /[\/\\%,;:)]+$/;                 // 트레일링 특수문자 정리

/**
 * Raw OCR 워드 배열을 3가지 EPC 카테고리로 분류합니다.
 *
 * @example
 * parsePidTags(["PSV", "0905A/", "39.9", "kg/cm2g", "4\"-PL-21-009013-B2A1-H"])
 * // → { equipment: ["PSV0905A"], lines: ["4\"-PL-21-009013-B2A1-H"], specs: ["39.9 kg/cm2g"] }
 */
export function parsePidTags(words: string[]): ParsedPidTags {
  if (!words || words.length === 0) {
    return { equipment: [], lines: [], specs: [] };
  }

  const equipment: string[] = [];
  const lines: string[] = [];
  const specs: string[] = [];
  const used = new Set<number>();

  // ━━ Pass 1: Line Numbers (하이픈 2개 이상 + 숫자 포함) ━━
  // 가장 구별력이 높으므로 먼저 추출하여 오분류 방지
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const hyphenCount = (w.match(/-/g) || []).length;
    if (hyphenCount >= 2 && /\d/.test(w) && w.length >= 8) {
      lines.push(w);
      used.add(i);
    }
  }

  // ━━ Pass 2: Complete Equipment Tags (단일 워드 PREFIX-NUMBER) ━━
  for (let i = 0; i < words.length; i++) {
    if (used.has(i)) continue;
    if (COMPLETE_TAG_RE.test(words[i])) {
      // 하이픈 제거: PSV-0905A → PSV0905A
      equipment.push(words[i].replace(/-/, ''));
      used.add(i);
    }
  }

  // ━━ Pass 3: Adjacent Merge (PREFIX + TAG_NUMBER, 2-word lookahead) ━━
  // OCR 노이즈(@, / 등)가 사이에 끼어도 2칸 내에서 결합
  for (let i = 0; i < words.length; i++) {
    if (used.has(i)) continue;
    const w = words[i];

    // 접두사 조건: 2~5자 대문자 + Known Prefix
    if (!PREFIX_RE.test(w) || !KNOWN_PREFIXES.has(w)) continue;

    // 1~2칸 뒤에서 태그번호 탐색
    for (let j = i + 1; j <= Math.min(i + 2, words.length - 1); j++) {
      if (used.has(j)) continue;
      const cleaned = words[j].replace(TRAILING_JUNK_RE, '');
      if (TAG_NUM_RE.test(cleaned) && cleaned.length >= 2) {
        equipment.push(`${w}${cleaned}`);
        used.add(i);
        used.add(j);
        // 사이에 있는 노이즈도 consumed 처리
        for (let k = i + 1; k < j; k++) used.add(k);
        break;
      }
      // 노이즈(1글자, 특수문자)만 건너뛰고 그 외는 탐색 중단
      if (words[j].length > 1 && /[A-Za-z0-9]{2,}/.test(words[j])) break;
    }
  }

  // ━━ Pass 4: Specs (스펙코드, 인치규격, 숫자+단위) ━━
  for (let i = 0; i < words.length; i++) {
    if (used.has(i)) continue;
    const w = words[i];

    // 4a: 스펙코드 — 숫자+영문자+숫자 (예: 1.5F2, 3R12, 150NB)
    if (SPEC_CODE_RE.test(w)) {
      specs.push(w);
      used.add(i);
      continue;
    }

    // 4b: 인치규격 — 숫자+인치마크(+서비스코드) (예: 44"PYLO, 6"CW)
    if (INCH_SPEC_RE.test(w)) {
      specs.push(w);
      used.add(i);
      continue;
    }

    // 4c: 숫자 + 인접 단위 결합 (예: 39.9 + kg/cm2g → "39.9 kg/cm2g")
    if (NUMERIC_RE.test(w)) {
      let merged = false;
      // 바로 다음 인덱스만 확인 (1-position lookahead)
      // 단위가 멀리 떨어져 있으면 다른 값의 단위일 가능성이 높으므로 보수적으로 처리
      if (i + 1 < words.length && !used.has(i + 1) && UNIT_RE.test(words[i + 1])) {
        specs.push(`${w} ${words[i + 1]}`);
        used.add(i);
        used.add(i + 1);
        merged = true;
      }
      if (merged) continue;
      // 단독 숫자 → 노이즈로 버림
      continue;
    }

    // 4d: 임베디드 숫자+단위 (예: "39.9kg/cm2g" 한 단어에 붙어있는 경우)
    const embedded = w.match(
      /^(\d+\.?\d*)(kg\/cm2g?|barg?|bara|bar|mmHg|mmH2O|MPa|kPa|psi[ag]?|mm|cm|°[CF]|℃)$/i
    );
    if (embedded) {
      specs.push(`${embedded[1]} ${embedded[2]}`);
      used.add(i);
      continue;
    }
  }

  // 중복 제거 후 반환
  return {
    equipment: [...new Set(equipment)],
    lines: [...new Set(lines)],
    specs: [...new Set(specs)],
  };
}
