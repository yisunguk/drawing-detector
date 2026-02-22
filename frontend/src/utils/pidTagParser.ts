/**
 * P&ID OCR Tag Parser v2 — Contextual Merging
 *
 * Azure Document Intelligence 추출 텍스트를 EPC 설계자의
 * 검색 의도(Search Intent)에 맞게 3카테고리로 분류하고,
 * 주변 텍스트 컨텍스트를 활용해 Key-Value 스펙을 조립합니다.
 *
 * 알고리즘 (5-Pass):
 *   Pass 1: 라인넘버 (하이픈 2+, 숫자 포함, 가장 구별력 높음)
 *   Pass 2: 완성형 기기태그 (PREFIX-NUMBER 단일 워드)
 *   Pass 3: 인접 머지 기기태그 (PREFIX + NUMBER, 2-word lookahead)
 *   Pass 4: 컨텍스트 스펙 (Keyword ↔ Number ↔ Unit 양방향 조합)
 *   Pass 5: 나머지 스펙 (스펙코드, 인치규격)
 *   나머지: 노이즈 버림
 */

// ── Output Types ──

export interface SpecEntry {
  label: string;    // EPC 속성명: "Set Pressure", "Design Temp"
  value: string;    // 수치: "39.9"
  unit: string;     // 단위: "kg/cm2g"
  display: string;  // UI 표시: "Set Press: 39.9 kg/cm2g"
  tag: string;      // 해시태그: "#SetPress_39.9"
}

export interface ParsedPidTags {
  equipment: string[];   // 기기/계기: PSV0905A
  lines: string[];       // 배관 라인: 4"-PL-21-009013-B2A1-H
  specs: SpecEntry[];    // 주요 속성: Key-Value 스펙
}

// ── EPC Keyword → Spec Label 사전 ──
// 2-word 복합 키워드 (우선 매칭)
const COMPOUND_KEYWORDS: Record<string, string> = {
  'SET PRESS': 'Set Pressure', 'SET PRESSURE': 'Set Pressure',
  'DESIGN PRESS': 'Design Pressure', 'DESIGN PRESSURE': 'Design Pressure',
  'DESIGN TEMP': 'Design Temp.', 'DESIGN TEMPERATURE': 'Design Temp.',
  'OPER PRESS': 'Oper. Pressure', 'OPERATING PRESS': 'Oper. Pressure',
  'OPER TEMP': 'Oper. Temp.', 'OPERATING TEMP': 'Oper. Temp.',
  'OPERATING PRESSURE': 'Oper. Pressure', 'OPERATING TEMPERATURE': 'Oper. Temp.',
  'BACK PRESS': 'Back Pressure', 'BACK PRESSURE': 'Back Pressure',
  'DIFF PRESS': 'Diff. Pressure', 'DIFF PRESSURE': 'Diff. Pressure',
  'TEST PRESS': 'Test Pressure', 'TEST PRESSURE': 'Test Pressure',
  'HYDRO TEST': 'Hydro Test',
  'INLET SIZE': 'Inlet Size', 'OUTLET SIZE': 'Outlet Size',
  'NORMAL FLOW': 'Normal Flow', 'MAX FLOW': 'Max Flow', 'MIN FLOW': 'Min Flow',
  'MAX TEMP': 'Max Temp.', 'MIN TEMP': 'Min Temp.',
  'COLD DIFF': 'CDTP', 'FULL OPEN': 'Full Open',
  'RELIEF PRESS': 'Relief Pressure', 'RELIEF TEMP': 'Relief Temp.',
  'SP GR': 'Sp. Gravity', 'MOL WT': 'Mol. Weight',
  'PIPE SIZE': 'Pipe Size', 'LINE SIZE': 'Line Size',
  'ORIFICE SIZE': 'Orifice', 'ORIFICE AREA': 'Orifice Area',
  'SET POINT': 'Set Point',
};

// 1-word 단일 키워드
const SINGLE_KEYWORDS: Record<string, string> = {
  'SET': 'Set Pressure', 'DESIGN': 'Design', 'OPERATING': 'Operating', 'OPER': 'Operating',
  'TEST': 'Test', 'MAX': 'Max', 'MIN': 'Min', 'NORMAL': 'Normal', 'RATED': 'Rated',
  'RELIEF': 'Relief', 'BACK': 'Back Pressure', 'INLET': 'Inlet', 'OUTLET': 'Outlet',
  'FLOW': 'Flow Rate', 'CAPACITY': 'Capacity', 'SIZE': 'Size',
  'TEMP': 'Temperature', 'PRESS': 'Pressure', 'PRESSURE': 'Pressure', 'TEMPERATURE': 'Temperature',
  'WEIGHT': 'Weight', 'WT': 'Weight', 'DIA': 'Diameter', 'BORE': 'Bore',
  'LENGTH': 'Length', 'AREA': 'Area', 'VELOCITY': 'Velocity',
  'DENSITY': 'Density', 'VISCOSITY': 'Viscosity', 'MW': 'Mol. Weight',
  'SG': 'Sp. Gravity', 'MAWP': 'MAWP', 'MDMT': 'MDMT',
};

// 키워드 전체 Set (노이즈 스킵 판별용)
const ALL_KEYWORDS = new Set([
  ...Object.keys(SINGLE_KEYWORDS),
  // compound의 개별 단어는 포함하지 않음 — compound 매칭으로 처리
]);

// ── Known EPC Instrument/Equipment Prefixes (90+) ──
const KNOWN_PREFIXES = new Set([
  'PT', 'PI', 'PIC', 'PIT', 'PDI', 'PDIC', 'PAH', 'PAL', 'PAHH', 'PALL',
  'PSV', 'PRV', 'PSE', 'PSH', 'PSL', 'PSHH', 'PSLL', 'PG', 'PB',
  'TI', 'TIC', 'TIT', 'TE', 'TT', 'TAH', 'TAL', 'TAHH', 'TALL',
  'TSH', 'TSL', 'TSHH', 'TSLL', 'TW', 'TG',
  'FI', 'FIC', 'FIT', 'FE', 'FT', 'FAH', 'FAL', 'FSH', 'FSL', 'FQ', 'FO',
  'LI', 'LIC', 'LIT', 'LE', 'LT', 'LAH', 'LAL', 'LAHH', 'LALL',
  'LSH', 'LSL', 'LSHH', 'LSLL', 'LG', 'LB',
  'AI', 'AIC', 'AIT', 'AE', 'AT',
  'XV', 'HV', 'PCV', 'TCV', 'FCV', 'LCV',
  'SDV', 'BDV', 'MOV', 'SOV', 'AOV',
  'CV', 'RV', 'BV', 'SV', 'NRV', 'GOV',
  'ZSO', 'ZSC', 'ZI', 'ZT', 'ZA', 'HS', 'HC', 'HIC',
  'HX', 'EX', 'ST', 'TK', 'VV', 'DR', 'PP',
  'AG', 'BL', 'CL', 'CR', 'EJ', 'FL',
  'PL', 'CW', 'SW', 'FW', 'IA', 'PA', 'NG', 'FG', 'LP', 'HP', 'MP',
]);

// ── EPC 표준 단위 패턴 ──
const UNIT_RE = /^(kg\/cm2g?|barg?|bara|bar|mmHg|mmH2O|mmWC|mbar|MPa|kPa|Pa|psi[ag]?|atm|mm|cm|m|in|ft|°[CF]|℃|℉|kg|ton|lb|g|m3\/h|m3\/hr|l\/min|LPM|GPM|SCFM|ACFM|Nm3\/h|Nm3\/hr|Hz|RPM|kW|HP|MW|kVA|NPS|DN|SCH|Sch|BWG|NB|m\/s|m\/sec|ft\/s|cP|cSt|API|ANSI|PN)$/i;

// ── Regex Helpers ──
const PREFIX_RE = /^[A-Z]{2,5}$/;
const TAG_NUM_RE = /^\d+[A-Z0-9]*$/;
const COMPLETE_TAG_RE = /^[A-Z]{2,5}-?\d+[A-Z0-9]*$/;
const NUMERIC_RE = /^\d+\.?\d*$/;
const SPEC_CODE_RE = /^\d+\.?\d*[A-Z][A-Z0-9]*$/;
const INCH_SPEC_RE = /^\d+[""\u2033\u201C\u201D]/;
const TRAILING_JUNK_RE = /[\/\\%,;:)]+$/;

// 노이즈 판별: 1글자 or 특수문자만
function isNoise(w: string): boolean {
  return w.length <= 1 || /^[^A-Za-z0-9]+$/.test(w);
}

// SpecEntry 생성 헬퍼
function makeSpec(label: string, value: string, unit: string): SpecEntry {
  const displayParts: string[] = [];
  if (label) displayParts.push(`${label}:`);
  displayParts.push(value);
  if (unit) displayParts.push(unit);
  const display = displayParts.join(' ');

  // 해시태그: #SetPress_39.9 형식 (공백/특수문자 제거)
  const tagLabel = label.replace(/[.\s]/g, '').replace(/[^A-Za-z0-9]/g, '_');
  const tagValue = value.replace(/[^A-Za-z0-9.]/g, '');
  const tag = label ? `#${tagLabel}_${tagValue}` : `#${tagValue}${unit ? '_' + unit.replace(/[^A-Za-z0-9]/g, '') : ''}`;

  return { label, value, unit, display, tag };
}

/**
 * Raw OCR 워드 배열을 3가지 EPC 카테고리로 분류합니다.
 * 주변 텍스트 컨텍스트를 활용해 Key-Value 스펙을 조립합니다.
 */
export function parsePidTags(words: string[]): ParsedPidTags {
  if (!words || words.length === 0) {
    return { equipment: [], lines: [], specs: [] };
  }

  const equipment: string[] = [];
  const lines: string[] = [];
  const specs: SpecEntry[] = [];
  const used = new Set<number>();

  // ━━ Pass 1: Line Numbers (하이픈 2개 이상 + 숫자 포함) ━━
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const hyphenCount = (w.match(/-/g) || []).length;
    if (hyphenCount >= 2 && /\d/.test(w) && w.length >= 8) {
      lines.push(w);
      used.add(i);
    }
  }

  // ━━ Pass 2: Complete Equipment Tags (PREFIX-NUMBER 단일 워드) ━━
  for (let i = 0; i < words.length; i++) {
    if (used.has(i)) continue;
    if (COMPLETE_TAG_RE.test(words[i])) {
      equipment.push(words[i].replace(/-/, ''));
      used.add(i);
    }
  }

  // ━━ Pass 3: Adjacent Merge (PREFIX + TAG_NUMBER, 2-word lookahead) ━━
  for (let i = 0; i < words.length; i++) {
    if (used.has(i)) continue;
    const w = words[i];
    if (!PREFIX_RE.test(w) || !KNOWN_PREFIXES.has(w)) continue;

    for (let j = i + 1; j <= Math.min(i + 2, words.length - 1); j++) {
      if (used.has(j)) continue;
      const cleaned = words[j].replace(TRAILING_JUNK_RE, '');
      if (TAG_NUM_RE.test(cleaned) && cleaned.length >= 2) {
        equipment.push(`${w}${cleaned}`);
        used.add(i);
        used.add(j);
        for (let k = i + 1; k < j; k++) used.add(k);
        break;
      }
      if (words[j].length > 1 && /[A-Za-z0-9]{2,}/.test(words[j])) break;
    }
  }

  // ━━ Pass 4: Contextual Specs (Keyword ↔ Number ↔ Unit 양방향 스캔) ━━
  // 각 숫자를 중심으로 ±3칸 내 키워드, +3칸 내 단위를 탐색
  for (let i = 0; i < words.length; i++) {
    if (used.has(i)) continue;
    const w = words[i];
    if (!NUMERIC_RE.test(w)) continue;

    let label = '';
    const keywordIndices: number[] = [];
    let unit = '';
    let unitIdx = -1;

    // ── 양방향 키워드 탐색 (±3칸, 노이즈 스킵) ──
    // 뒤쪽(behind) 먼저 탐색
    for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
      if (used.has(j)) continue;
      const upper = words[j].toUpperCase();

      // 2-word compound 체크 (j-1 + j)
      if (j > 0 && !used.has(j - 1)) {
        const compound = words[j - 1].toUpperCase() + ' ' + upper;
        if (COMPOUND_KEYWORDS[compound]) {
          label = COMPOUND_KEYWORDS[compound];
          keywordIndices.push(j - 1, j);
          break;
        }
      }
      // 1-word 키워드 체크
      if (SINGLE_KEYWORDS[upper]) {
        label = SINGLE_KEYWORDS[upper];
        keywordIndices.push(j);
        break;
      }
      if (!isNoise(words[j])) break; // 의미있는 비키워드 → 탐색 중단
    }

    // 앞쪽(ahead) 키워드 탐색 — 뒤쪽에서 못 찾았을 때만
    if (!label) {
      for (let j = i + 1; j <= Math.min(i + 3, words.length - 1); j++) {
        if (used.has(j)) continue;
        const upper = words[j].toUpperCase();

        // 2-word compound (j + j+1)
        if (j + 1 < words.length && !used.has(j + 1)) {
          const compound = upper + ' ' + words[j + 1].toUpperCase();
          if (COMPOUND_KEYWORDS[compound]) {
            label = COMPOUND_KEYWORDS[compound];
            keywordIndices.push(j, j + 1);
            break;
          }
        }
        if (SINGLE_KEYWORDS[upper]) {
          label = SINGLE_KEYWORDS[upper];
          keywordIndices.push(j);
          break;
        }
        // 단위가 아니고 노이즈도 아닌 단어 → 탐색 중단
        if (!isNoise(words[j]) && !UNIT_RE.test(words[j])) break;
      }
    }

    // ── 앞쪽 단위 탐색 (+3칸, 노이즈/키워드 스킵) ──
    for (let j = i + 1; j <= Math.min(i + 3, words.length - 1); j++) {
      if (used.has(j) || keywordIndices.includes(j)) continue;
      if (UNIT_RE.test(words[j])) {
        unit = words[j];
        unitIdx = j;
        break;
      }
      // 키워드나 노이즈는 건너뛰기
      if (isNoise(words[j]) || ALL_KEYWORDS.has(words[j].toUpperCase())) continue;
      break;
    }

    // 키워드도 단위도 없는 단독 숫자 → 노이즈
    if (!label && !unit) continue;

    specs.push(makeSpec(label, w, unit));
    used.add(i);
    keywordIndices.forEach(idx => used.add(idx));
    if (unitIdx >= 0) used.add(unitIdx);
  }

  // ━━ Pass 5: 나머지 스펙 (스펙코드, 인치규격) ━━
  for (let i = 0; i < words.length; i++) {
    if (used.has(i)) continue;
    const w = words[i];

    // 인치규격 + 서비스코드 (예: 44"PYLO → Pipe: 44"PYLO)
    if (INCH_SPEC_RE.test(w)) {
      const sizeMatch = w.match(/^(\d+)[""\u2033\u201C\u201D](.*)$/);
      if (sizeMatch) {
        const size = sizeMatch[1];
        const service = sizeMatch[2] || '';
        const lbl = service ? 'Pipe' : 'Size';
        specs.push(makeSpec(lbl, `${size}"${service}`, ''));
      } else {
        specs.push(makeSpec('Size', w, ''));
      }
      used.add(i);
      continue;
    }

    // 스펙코드 (예: 1.5F2 → Spec: 1.5F2)
    if (SPEC_CODE_RE.test(w)) {
      specs.push(makeSpec('Spec', w, ''));
      used.add(i);
      continue;
    }
  }

  // 중복 제거
  const seenEquip = new Set<string>();
  const seenLines = new Set<string>();
  const seenSpecs = new Set<string>();

  return {
    equipment: equipment.filter(e => { if (seenEquip.has(e)) return false; seenEquip.add(e); return true; }),
    lines: lines.filter(l => { if (seenLines.has(l)) return false; seenLines.add(l); return true; }),
    specs: specs.filter(s => { if (seenSpecs.has(s.display)) return false; seenSpecs.add(s.display); return true; }),
  };
}
