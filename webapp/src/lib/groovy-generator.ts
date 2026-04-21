import { OpenAIClient } from '@/lib/test-generation/openai-client'
import type { ParsedTestCase } from './excel-parser'

// Reference Groovy file examples embedded as template strings.
// These are truncated but representative — enough for the model to understand
// the structure: package declaration, Katalon imports, TestCaseGeneratorBase
// subclass, constructor with scenario routing, buildXmlRequest, buildRequest,
// and @Keyword element-builder methods using groovy.xml.MarkupBuilder.
const AIR_SHOPPING_REFERENCE = `package ndc172
import com.kms.katalon.core.annotation.Keyword
import com.kms.katalon.core.webservice.keyword.WSBuiltInKeywords as WS
import common.TestCaseGeneratorBase
import internal.GlobalVariable

class AirShoppingRQ extends TestCaseGeneratorBase{
  def rebookIndicator = false
  def reshopIndicator = false
  def twoStepIndicator = false
  def currentRequest
  def flightPropsmap = [:]
  def shoppingRS

  AirShoppingRQ() {}

  AirShoppingRQ(dataObject, scenario) {
    super(dataObject)
    if (scenario.contains('AS') && (dataObject.getNDC_Version() != '21.3')) {
      dataObject.setTransactionName("AirShopping")
      dataObject.setTestStepName("AirShoppingRQ")
      dataObject.setTestStepNameList("AirShoppingRQ")
    }
    if (scenario.contains('AS') && dataObject.getRuleID_TwoStep() && (dataObject.getNDC_Version() != '21.3')) {
      dataObject.setTransactionName("AirShopping")
      dataObject.setTestStepName("AirShoppingRQ-2STEP")
      dataObject.setTestStepNameList("AirShoppingRQ-2STEP")
    }
    updateDataObject(dataObject)
  }

  def buildXmlRequest(request) {
    request.setDoubleQuotes(true)
    buildEnvelope(request, dataObject.getTransactionName())
  }

  def buildRequest(request) {
    if (currentRequest.equals("AirShoppingRQ-Rebook")) rebookIndicator = true
    if (currentRequest.equals("AirShoppingRQ-Reshop")) reshopIndicator = true
    if (currentRequest.equals("AirShoppingRQ-2STEP")) {
      twoStepIndicator = true
      shoppingRS = dataObject.TestStepRqRsMap["AirShoppingRQ"]["response"]
    }
    request.AirShoppingRQ(Version: "17.2", TransactionIdentifier: java.util.UUID.randomUUID().toString().replaceAll("-","")) {
      pointOfSale(request)
      Document(id: "document")
      party_sender(request)
      parameters(request)
      coreQuery(request)
      qualifier(request)
      preference(request)
      dataList(request)
      metaData(request)
    }
  }

  @Keyword
  def coreQuery() {
    currentRequest = dataObject.getTestStepName()
    def writer = new StringWriter()
    def request = new groovy.xml.MarkupBuilder(writer)
    request.setOmitEmptyAttributes(true)
    request.setOmitNullAttributes(true)
    def market = dataObject.getMarket()
    def marketArray = market.tokenize(",")
    def numberOfODs = marketArray.size()
    def travelDates = dataObject.getTravel_Dates()
    def travelDatesArray = travelDates ? travelDates.split(",") : []
    def dateOffset = dataObject.getDateOffset()
    if (!rebookIndicator && !reshopIndicator && !twoStepIndicator) {
      request.CoreQuery {
        OriginDestinations {
          for (od in 1..numberOfODs) {
            def odArray = marketArray[od - 1].split("-")
            OriginDestination(OriginDestinationKey: "OD\$od") {
              Departure {
                AirportCode(odArray[0])
                def travelDatesFlag = travelDatesArray.size() > (od - 1) ? travelDatesArray[od - 1] : null
                if (!travelDatesFlag) {
                  dateOffset += 10
                  def date = String.format('%tF', new Date() + dateOffset + 120)
                  'Date'(date)
                } else {
                  'Date'(travelDatesArray[od - 1])
                }
              }
              Arrival { AirportCode(odArray[1]) }
            }
          }
        }
      }
    }
    return writer.toString()
  }

  @Keyword
  def qualifier() {
    def writer = new StringWriter()
    def request = new groovy.xml.MarkupBuilder(writer)
    request.setOmitEmptyAttributes(true)
    request.setOmitNullAttributes(true)
    def corporateAccount = dataObject.getCorporate_ID()
    def promoCode = dataObject.getPromo_Code()
    if (corporateAccount || promoCode) {
      request.Qualifier {
        if (promoCode) {
          PromotionQualifiers {
            Code(promoCode)
            Issuer { AirlineID(dataObject.getQualifier_AirlineID()) }
          }
        }
      }
    }
    return writer.toString()
  }

  @Keyword
  def preference() {
    def writer = new StringWriter()
    def request = new groovy.xml.MarkupBuilder(writer)
    request.setOmitEmptyAttributes(true)
    request.setOmitNullAttributes(true)
    def farePreferences = dataObject.getFareType()
    def cabin = dataObject.getCabin_Code()
    if (farePreferences || cabin) {
      request.Preference {
        if (farePreferences) {
          FarePreferences {
            Types {
              farePreferences.tokenize(",").each { Type(it) }
            }
          }
        }
        if (cabin) {
          CabinPreferences {
            cabin.tokenize(",").eachWithIndex { elem, index ->
              CabinType {
                Code(elem)
                OriginDestinationReferences("OD\${index + 1}")
              }
            }
          }
        }
      }
    }
    return writer.toString()
  }

  @Keyword
  def dataList() {
    def writer = new StringWriter()
    def request = new groovy.xml.MarkupBuilder(writer)
    request.setOmitEmptyAttributes(true)
    request.setOmitNullAttributes(true)
    request.DataLists { passengerList(request) }
    return writer.toString()
  }

  @Keyword
  def metaData() {
    def writer = new StringWriter()
    def request = new groovy.xml.MarkupBuilder(writer)
    request.setOmitEmptyAttributes(true)
    request.setOmitNullAttributes(true)
    return writer.toString()
  }
}`

const OFFER_PRICE_REFERENCE = `package ndc172
import com.kms.katalon.core.annotation.Keyword
import com.kms.katalon.core.webservice.keyword.WSBuiltInKeywords as WS
import common.TestCaseGeneratorBase
import internal.GlobalVariable

class OfferPriceRQ extends TestCaseGeneratorBase{
  def flightPropsmap = dataObject.getFlightProps()
  def currentRequest
  def opReq
  def twoStepIndicator = false
  def pricingRS
  def rs

  OfferPriceRQ() {}

  OfferPriceRQ(dataObject, scenario) {
    super(dataObject)
    if (scenario.contains('OP') && (dataObject.getNDC_Version() != '21.3')) {
      dataObject.setTransactionName("OfferPrice")
      dataObject.setTestStepName("OfferPriceRQ")
      dataObject.setTestStepNameList("OfferPriceRQ")
    }
    if (scenario.contains('OP->OP') && dataObject.getOfferPrice_Fare_PreferencesContext()?.contains("UpsellFares")) {
      dataObject.setTransactionName("OfferPrice")
      dataObject.setTestStepName("OfferPriceRQ_2STEP")
      dataObject.setTestStepNameList("OfferPriceRQ_2STEP")
    }
    updateDataObject(dataObject)
    currentRequest = dataObject.getTestStepName()
  }

  def buildXmlRequest(request) {
    request.setDoubleQuotes(true)
    buildEnvelope(request, dataObject.getTransactionName())
  }

  def buildRequest(request) {
    def longSellIndicator = false
    def numberOfODs = 0
    def segmentsArray = []
    if (currentRequest.equals("OfferPriceRQ_2STEP") && dataObject.getRuleID_TwoStep()?.equalsIgnoreCase("Y")) {
      twoStepIndicator = true
      pricingRS = dataObject.TestStepRqRsMap["OfferPriceRQ"]["response"]
    }
    request.OfferPriceRQ(Version: "17.2", TransactionIdentifier: java.util.UUID.randomUUID().toString().replaceAll("-","")) {
      pointOfSale(request)
      Document(id: "document")
      party_sender(request)
      parameters(request)
      (longSellIndicator, numberOfODs, segmentsArray) = query(request)
      preference(request)
      qualifier(request)
      dataList(request, longSellIndicator, numberOfODs, segmentsArray)
      metadata(request, longSellIndicator, numberOfODs, segmentsArray)
    }
  }

  @Keyword
  def query() {
    def writer = new StringWriter()
    def request = new groovy.xml.MarkupBuilder(writer)
    request.setOmitEmptyAttributes(true)
    request.setOmitNullAttributes(true)
    def ptcArray = dataObject.getPtcArray()
    def market = dataObject.getMarket()
    def marketArray = market.tokenize(",")
    def numberOfODs = marketArray.size()
    def longSellIndicator = dataObject.getLongSell() ? dataObject.getLongSell().equalsIgnoreCase("Y") : false
    def segmentsArray = []
    if (pricingRS) rs = new XmlSlurper().parseText(getPayload(pricingRS))
    request.Query {
      def flightSelectors = dataObject.getFlightSelector()
      segmentsArray = flightSelectors.tokenize(",")
      segmentsArray.eachWithIndex { selector, od ->
        segmentsArray[od] = selector.find(/.*s(\d+).*/) { it[1] }?.toInteger() ?: 1
      }
      if (!longSellIndicator) {
        def ods = 1
        def seg = 1
        Offer(OfferID: flightPropsmap.get("OD0\${ods}-S\${seg}-OfferId"), Owner: flightPropsmap.get("OD0\${ods}-S\${seg}-OfferIdOwner"), ResponseID: flightPropsmap.get("ResponseId")) {
          def ptcArray_Unique = new ArrayList(ptcArray)
          ptcArray_Unique.unique()
          for (ptc in 1..ptcArray_Unique.size()) {
            OfferItem(OfferItemID: flightPropsmap.get("OD01-S1-OfferItemId\$ptc")) {
              PassengerRefs(flightPropsmap.get("OD01-S1-PassengerRefs\$ptc"))
            }
          }
        }
      }
    }
    return [longSellIndicator, numberOfODs, segmentsArray, writer.toString()]
  }

  @Keyword
  def preference() {
    def writer = new StringWriter()
    def request = new groovy.xml.MarkupBuilder(writer)
    request.setOmitEmptyAttributes(true)
    request.setOmitNullAttributes(true)
    def farePreferences = dataObject.getOfferPrice_FareType()
    def prefContext = dataObject.getOfferPrice_Fare_PreferencesContext() ?: ""
    request.Preference {
      FarePreferences(PreferencesContext: "\$prefContext") {
        Types {
          if (farePreferences) {
            farePreferences.tokenize(",").each { Type(it) }
          } else {
            Type('70J')
            Type('749')
          }
        }
      }
      PricingMethodPreference { BestPricingOption(dataObject.getOfferPrice_BestPricing_Preference() ?: "N") }
      ServicePricingOnlyPreference { ServicePricingOnlyInd("false") }
    }
    return writer.toString()
  }

  @Keyword
  def qualifier() {
    def writer = new StringWriter()
    def request = new groovy.xml.MarkupBuilder(writer)
    request.setOmitEmptyAttributes(true)
    request.setOmitNullAttributes(true)
    def corporateAccount = dataObject.getOfferPrice_Corporate_ID()
    def promoCode = dataObject.getOfferPrice_Promo_Code()
    if (corporateAccount || promoCode) {
      request.Qualifier {
        if (promoCode) {
          PromotionQualifiers {
            Code(promoCode)
            Issuer { AirlineID(dataObject.getOfferPrice_Qualifier_AirlineID()) }
          }
        }
      }
    }
    return writer.toString()
  }

  @Keyword
  def dataList(longSellIndicator, numberOfODs, segmentsArray) {
    def writer = new StringWriter()
    def request = new groovy.xml.MarkupBuilder(writer)
    request.setOmitEmptyAttributes(true)
    request.setOmitNullAttributes(true)
    request.DataLists { passengerList(request) }
    return writer.toString()
  }

  @Keyword
  def metadata(longSellIndicator, numberOfODs, segmentsArray) {
    def writer = new StringWriter()
    def request = new groovy.xml.MarkupBuilder(writer)
    request.setOmitEmptyAttributes(true)
    request.setOmitNullAttributes(true)
    return writer.toString()
  }
}`

export interface GroovyGenerationResult {
  className: string
  apiType: string
  fileName: string
  content: string
  error?: string
}

export async function generateGroovyFile(
  apiType: string,
  testCases: ParsedTestCase[],
  openaiApiKey: string
): Promise<GroovyGenerationResult> {
  const className = apiType // e.g. "AirShoppingRQ"
  const fileName = `${className}.groovy`

  // Summarize the test cases that involve this API for context
  const relevantCases = testCases
    .filter((tc) => {
      if (!tc.scenario) return false
      // Check if this API's typical abbreviation appears in the scenario
      const abbrevs = Object.entries({
        AirShoppingRQ: 'AS',
        OfferPriceRQ: 'OP',
        OrderCreateRQ: 'OC',
        OrderRetrieveRQ: 'OR',
        OrderChangeRQ: 'OCH',
        OrderReshopRQ: 'ORS',
        OrderExchangeRQ: 'Exch',
        SeatAvailabilityRQ: 'SA',
        PriceCalendarRQ: 'PCL',
        TicketIssuanceRQ: 'TI',
        FarePriceRQ: 'FP',
        AirAvailabilityRQ: 'AV',
        PriceRQ: 'PR',
      })
      const entry = abbrevs.find(([cls]) => cls === apiType)
      if (!entry) return true // unknown type, include all
      return tc.scenario.split(/->|,|\s+/).includes(entry[1])
    })
    .slice(0, 30) // cap to keep prompt size reasonable

  const testCaseSummary = relevantCases
    .map((tc) => `  - ${tc.tc_id}: scenario="${tc.scenario}", area="${tc.functional_area}", desc="${tc.description}"`)
    .join('\n')

  const allScenarios = [...new Set(relevantCases.map((tc) => tc.scenario).filter(Boolean))]

  const client = new OpenAIClient({
    apiKey: openaiApiKey,
    maxTokens: 8000,
    reasoningEffort: 'medium',
    timeout: 120_000,
  })

  const systemPrompt = `You are a Katalon Studio Groovy expert generating NDC airline API test classes.

Generate a complete, production-quality Groovy class file for the ${className} NDC API transaction.

STRICT RULES:
1. Package must be exactly: package ndc172
2. Class must extend TestCaseGeneratorBase
3. Include ALL standard Katalon imports shown in the reference files
4. Constructor must accept (dataObject, scenario) and route to different test step names based on scenario content
5. Must have: buildXmlRequest(request), buildRequest(request), and @Keyword methods for each XML element group (query/coreQuery, qualifier, preference, dataList, metadata/metaData, passengerList)
6. Use groovy.xml.MarkupBuilder with setOmitEmptyAttributes(true) and setOmitNullAttributes(true)
7. Read all test data via dataObject getter methods (e.g. dataObject.getMarket(), dataObject.getFlightSelector())
8. Handle ALL scenario variants present in the test cases (standard, rebook, reshop, 2-step, exchange, etc.)
9. Return raw Groovy code only — NO markdown fences, NO explanations
10. Use TransactionIdentifier: java.util.UUID.randomUUID().toString().replaceAll("-","") in the root element`

  const userPrompt = `REFERENCE EXAMPLE 1 — AirShoppingRQ:
${AIR_SHOPPING_REFERENCE}

REFERENCE EXAMPLE 2 — OfferPriceRQ:
${OFFER_PRICE_REFERENCE}

TEST CASES THAT USE ${className}:
${testCaseSummary || '  (No specific test cases — generate a general implementation)'}

SCENARIO VARIANTS TO HANDLE:
${allScenarios.map((s) => `  - ${s}`).join('\n') || '  - Standard flow'}

Now generate the complete ${fileName} Groovy class file. Follow the exact structure of the reference files. The class name must be ${className}.`

  try {
    const result = await client.callOpenAI([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ])

    // Strip any accidental markdown code fences
    let content = result.text.trim()
    content = content.replace(/^```(?:groovy)?\n?/i, '').replace(/\n?```$/i, '').trim()

    // Ensure it starts with the package declaration
    if (!content.startsWith('package ndc172')) {
      const packageIdx = content.indexOf('package ndc172')
      if (packageIdx > 0) {
        content = content.slice(packageIdx)
      }
    }

    return { className, apiType, fileName, content }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      className,
      apiType,
      fileName,
      content: `// Generation failed: ${message}`,
      error: message,
    }
  }
}
