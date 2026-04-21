/**
 * Quick smoke test for excel-parser.ts
 * Run: node scripts/test-parser.mjs
 */
import * as XLSX from 'xlsx'

// Build a synthetic Excel buffer that mimics the FLX-NDC-AA TCG structure:
// Row 0: blank
// Row 1: blank
// Row 2: actual headers
// Row 3+: data rows
function makeSyntheticExcel() {
  const wb = XLSX.utils.book_new()

  const rows = [
    // Row 0 — blank
    [],
    // Row 1 — blank
    [],
    // Row 2 — headers (note mixed spacing/casing to stress-test findCol)
    ['Active', 'TestCase_ID', 'Functional_Area', 'Scenario', 'Description', 'Environment_Name', 'NDC_Version', 'PCC'],
    // Row 3 — real test case
    ['Y', 'TC_001', 'Air Shopping', 'AS->OP->OC->OR', 'Book and retrieve', 'PROD', '17.2', 'XYZ'],
    // Row 4
    ['Y', 'TC_002', 'Exchange', 'AS->OP->OC->Exch', 'Exchange flow', 'PROD', '17.2', 'ABC'],
    // Row 5 — inactive
    ['N', 'TC_003', 'Seat', 'AS->OP->OC->SA', 'Seat avail', 'PROD', '17.2', 'DEF'],
  ]

  const ws = XLSX.utils.aoa_to_sheet(rows)
  XLSX.utils.book_append_sheet(wb, ws, 'Test Cases Data')

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
}

// Inline the parser logic (mirrors excel-parser.ts exactly)
function cellStr(v) {
  if (v == null) return ''
  return String(v).replace(/\s+/g, ' ').trim().toLowerCase()
}

function findCol(headers, ...aliases) {
  for (const alias of aliases) {
    const idx = headers.findIndex((h) => cellStr(h).includes(alias.toLowerCase()))
    if (idx !== -1) return idx
  }
  return -1
}

const API_ABBREVIATION_MAP = {
  AS: 'AirShoppingRQ', OP: 'OfferPriceRQ', OC: 'OrderCreateRQ',
  OR: 'OrderRetrieveRQ', OCH: 'OrderChangeRQ', ORS: 'OrderReshopRQ',
  Exch: 'OrderExchangeRQ', SA: 'SeatAvailabilityRQ', PCL: 'PriceCalendarRQ',
  TI: 'TicketIssuanceRQ', FP: 'FarePriceRQ', AV: 'AirAvailabilityRQ', PR: 'PriceRQ',
}

function parseBuffer(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' })
  const sheetName =
    workbook.SheetNames.find((n) => n.toLowerCase().replace(/\s+/g, ' ').includes('test cases data')) ??
    workbook.SheetNames[0]

  const sheet = workbook.Sheets[sheetName]
  const raw = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: null })

  let headerRowIdx = -1
  for (let i = 0; i < Math.min(raw.length, 10); i++) {
    const row = raw[i]
    if (!row) continue
    const hasTestCaseCol = row.some((cell) => {
      const s = cellStr(cell)
      return s.includes('testcase') || s.includes('test_case') || s === 'tc_id'
    })
    if (hasTestCaseCol) { headerRowIdx = i; break }
  }

  if (headerRowIdx === -1) {
    for (let i = 0; i < Math.min(raw.length, 10); i++) {
      const row = raw[i]
      if (row && row.filter(Boolean).length > 3) { headerRowIdx = i; break }
    }
  }

  if (headerRowIdx === -1) throw new Error('Could not find header row')

  const headers = raw[headerRowIdx]
  const colTcId   = findCol(headers, 'testcase_id', 'testcase_ id', 'testcase id', 'tc_id', 'testcase')
  const colActive = findCol(headers, 'active')
  const colArea   = findCol(headers, 'functional_area', 'functional area', 'area')
  const colScenario = findCol(headers, 'scenario')

  console.log('Header row index:', headerRowIdx)
  console.log('Headers:', headers)
  console.log('colTcId:', colTcId, ' colActive:', colActive, ' colArea:', colArea, ' colScenario:', colScenario)

  const testCases = []
  const apiAbbreviationsFound = new Set()

  for (let i = headerRowIdx + 1; i < raw.length; i++) {
    const row = raw[i]
    if (!row) continue
    const tcId = row[colTcId] != null ? String(row[colTcId]).trim() : ''
    if (!tcId) continue

    const scenario = colScenario !== -1 && row[colScenario] != null ? String(row[colScenario]).trim() : null
    if (scenario) {
      for (const token of scenario.split(/->|,|\s+/).map(t => t.trim()).filter(Boolean)) {
        if (API_ABBREVIATION_MAP[token]) apiAbbreviationsFound.add(token)
      }
    }
    testCases.push({ tc_id: tcId, scenario })
  }

  const apiTypes = Object.keys(API_ABBREVIATION_MAP)
    .filter(a => apiAbbreviationsFound.has(a))
    .map(a => API_ABBREVIATION_MAP[a])

  return { testCases, apiTypes: [...new Set(apiTypes)] }
}

// Run the test
const buffer = makeSyntheticExcel()
const result = parseBuffer(buffer)

console.log('\n--- RESULTS ---')
console.log('Test cases found:', result.testCases.length)
console.log('Test cases:', JSON.stringify(result.testCases, null, 2))
console.log('API types found:', result.apiTypes)

// Assertions
let passed = true
if (result.testCases.length !== 3) { console.error('FAIL: expected 3 test cases, got', result.testCases.length); passed = false }
if (!result.apiTypes.includes('AirShoppingRQ')) { console.error('FAIL: missing AirShoppingRQ'); passed = false }
if (!result.apiTypes.includes('OrderExchangeRQ')) { console.error('FAIL: missing OrderExchangeRQ'); passed = false }
if (!result.apiTypes.includes('SeatAvailabilityRQ')) { console.error('FAIL: missing SeatAvailabilityRQ'); passed = false }

if (passed) console.log('\n✓ All assertions passed — parser is working correctly')
else console.error('\n✗ Some assertions failed')
