import * as XLSX from 'xlsx'

export interface ParsedTestCase {
  tc_id: string
  active: string | null
  functional_area: string | null
  scenario: string | null
  description: string | null
  environment_name: string | null
  ndc_version: string | null
  pcc: string | null
  raw_data: Record<string, unknown>
}

export interface ParsedExcelResult {
  testCases: ParsedTestCase[]
  apiTypes: string[]
}

// Maps scenario abbreviation tokens → Katalon class names
const API_ABBREVIATION_MAP: Record<string, string> = {
  AS: 'AirShoppingRQ',
  OP: 'OfferPriceRQ',
  OC: 'OrderCreateRQ',
  OR: 'OrderRetrieveRQ',
  OCH: 'OrderChangeRQ',
  ORS: 'OrderReshopRQ',
  Exch: 'OrderExchangeRQ',
  SA: 'SeatAvailabilityRQ',
  PCL: 'PriceCalendarRQ',
  TI: 'TicketIssuanceRQ',
  FP: 'FarePriceRQ',
  AV: 'AirAvailabilityRQ',
  PR: 'PriceRQ',
  OD: 'OrderDeliveryRQ',
}

// Normalise a cell value to a plain lowercase string for comparison
function cellStr(v: unknown): string {
  if (v == null) return ''
  return String(v).replace(/\s+/g, ' ').trim().toLowerCase()
}

// Find which column index holds a given logical field, case-insensitively
// `aliases` is ordered from most-specific to least-specific
function findCol(headers: unknown[], ...aliases: string[]): number {
  for (const alias of aliases) {
    const idx = headers.findIndex((h) => cellStr(h).includes(alias.toLowerCase()))
    if (idx !== -1) return idx
  }
  return -1
}

export function parseExcelTCG(buffer: Buffer): ParsedExcelResult {
  const workbook = XLSX.read(buffer, { type: 'buffer' })

  // Prefer the "Test Cases Data" sheet; fall back to first sheet
  const sheetName =
    workbook.SheetNames.find((n) => n.toLowerCase().replace(/\s+/g, ' ').includes('test cases data')) ??
    workbook.SheetNames[0]

  if (!sheetName) throw new Error('No sheets found in the Excel file')

  const sheet = workbook.Sheets[sheetName]

  // Read as a 2-D array so we control header detection ourselves
  const raw: unknown[][] = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: false,
    defval: null,
  }) as unknown[][]

  // Scan rows to find the header row — the one that contains "testcase" or "testcase_id"
  let headerRowIdx = -1
  for (let i = 0; i < Math.min(raw.length, 10); i++) {
    const row = raw[i]
    if (!row) continue
    const hasTestCaseCol = row.some((cell) => {
      const s = cellStr(cell)
      return s.includes('testcase') || s.includes('test_case') || s === 'tc_id'
    })
    if (hasTestCaseCol) {
      headerRowIdx = i
      break
    }
  }

  if (headerRowIdx === -1) {
    // Fallback: try the first row that has more than 3 non-empty cells
    for (let i = 0; i < Math.min(raw.length, 10); i++) {
      const row = raw[i]
      if (row && row.filter(Boolean).length > 3) {
        headerRowIdx = i
        break
      }
    }
  }

  if (headerRowIdx === -1) {
    throw new Error(
      `Could not find a header row in sheet "${sheetName}". ` +
      `Make sure the sheet has columns including "TestCase_ID" or "Active".`
    )
  }

  const headers = raw[headerRowIdx]

  // Map logical fields to column indices (flexible aliases)
  const colTcId       = findCol(headers, 'testcase_id', 'testcase_ id', 'testcase id', 'tc_id', 'testcase')
  const colActive     = findCol(headers, 'active')
  const colArea       = findCol(headers, 'functional_area', 'functional area', 'area')
  const colScenario   = findCol(headers, 'scenario')
  const colDesc       = findCol(headers, 'description', 'desc')
  const colEnv        = findCol(headers, 'environment_name', 'environment name', 'environment')
  const colNdc        = findCol(headers, 'ndc_version', 'ndc version', 'ndc')
  const colPcc        = findCol(headers, 'pcc')

  if (colTcId === -1) {
    const found = headers.filter(Boolean).map((h) => String(h)).join(', ')
    throw new Error(
      `Could not find a "TestCase_ID" column. ` +
      `Columns found in row ${headerRowIdx + 1}: [${found}]`
    )
  }

  const testCases: ParsedTestCase[] = []
  const apiAbbreviationsFound = new Set<string>()

  // Data starts from the row after the header row
  for (let i = headerRowIdx + 1; i < raw.length; i++) {
    const row = raw[i]
    if (!row) continue

    const tcId = row[colTcId] != null ? String(row[colTcId]).trim() : ''

    // Skip blank rows and sub-header rows (where TC ID equals the column label itself)
    if (!tcId) continue
    const tcLower = tcId.toLowerCase()
    if (tcLower === 'testcase_id' || tcLower === 'testcase_ id' || tcLower === 'tc_id') continue

    const scenario = colScenario !== -1 && row[colScenario] != null
      ? String(row[colScenario]).trim()
      : null

    // Extract API abbreviations from scenario chains like "AS->OP->OC->OR->Exch"
    if (scenario) {
      const tokens = scenario.split(/->|,|\s+/).map((t) => t.trim()).filter(Boolean)
      for (const token of tokens) {
        if (API_ABBREVIATION_MAP[token]) {
          apiAbbreviationsFound.add(token)
        }
      }
    }

    // Build raw_data as a keyed object using header names
    const rawData: Record<string, unknown> = {}
    headers.forEach((h, idx) => {
      if (h != null && row[idx] != null) {
        rawData[String(h)] = row[idx]
      }
    })

    testCases.push({
      tc_id: tcId,
      active:           colActive  !== -1 && row[colActive]  != null ? String(row[colActive]).trim()  : null,
      functional_area:  colArea    !== -1 && row[colArea]    != null ? String(row[colArea]).trim()    : null,
      scenario,
      description:      colDesc    !== -1 && row[colDesc]    != null ? String(row[colDesc]).trim()    : null,
      environment_name: colEnv     !== -1 && row[colEnv]     != null ? String(row[colEnv]).trim()     : null,
      ndc_version:      colNdc     !== -1 && row[colNdc]     != null ? String(row[colNdc]).trim()     : null,
      pcc:              colPcc     !== -1 && row[colPcc]     != null ? String(row[colPcc]).trim()     : null,
      raw_data: rawData,
    })
  }

  // Resolve abbreviations to class names in a deterministic order
  const orderedAbbreviations = Object.keys(API_ABBREVIATION_MAP)
  const apiTypes = orderedAbbreviations
    .filter((abbr) => apiAbbreviationsFound.has(abbr))
    .map((abbr) => API_ABBREVIATION_MAP[abbr])

  const uniqueApiTypes = [...new Set(apiTypes)]

  return { testCases, apiTypes: uniqueApiTypes }
}
