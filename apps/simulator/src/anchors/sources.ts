/**
 * The registry of every external value the simulator is anchored on.
 *
 * Nothing enters the generated dataset without an entry here. A figure whose
 * source could not be retrieved is not quietly replaced with a plausible one:
 * it is recorded as a failure, and the value that stands in for it is marked as
 * an assumption in the record's own provenance field, so a reader of the data
 * can see which is which without reading this file.
 *
 * Retrieval dates are the date the source was fetched, not the date of the
 * document. See `docs/DATA_PROVENANCE.md` for the assumptions table that
 * accompanies this registry.
 */

export type SourceStatus = 'retrieved' | 'partial' | 'failed';

export interface SourceRecord {
  readonly id: string;
  readonly title: string;
  readonly publisher: string;
  readonly url: string;
  readonly licence: string;
  /** The date this source was fetched, as ISO date. */
  readonly retrievedOn: string;
  readonly status: SourceStatus;
  /** What was actually obtained, including what was not. */
  readonly note: string;
}

const RETRIEVED_ON = '2026-09-25';

export const SOURCES: readonly SourceRecord[] = [
  {
    id: 'census2011-districts-odisha',
    title: 'List of districts of Orissa — population, Census 2011',
    publisher: 'Census of India 2011, Government of India (compiled listing)',
    url: 'https://www.census2011.co.in/census/state/districtlist/orissa.html',
    licence: 'Government of India census data, reproduced as attributed reference values',
    retrievedOn: RETRIEVED_ON,
    status: 'retrieved',
    note: 'All 30 district populations retrieved and used verbatim. State total cross-checked against the Odisha state government figure of 41,974,218.',
  },
  {
    id: 'census2011-districts-bihar',
    title: 'List of districts of Bihar — population, Census 2011',
    publisher: 'Census of India 2011, Government of India (compiled listing)',
    url: 'https://www.census2011.co.in/census/state/districtlist/bihar.html',
    licence: 'Government of India census data, reproduced as attributed reference values',
    retrievedOn: RETRIEVED_ON,
    status: 'retrieved',
    note: 'All 38 district populations retrieved and used verbatim.',
  },
  {
    id: 'census2011-states',
    title: 'State populations, Census 2011',
    publisher: 'Census of India 2011, Government of India (compiled listing)',
    url: 'https://www.census2011.co.in/states.php',
    licence: 'Government of India census data, reproduced as attributed reference values',
    retrievedOn: RETRIEVED_ON,
    status: 'partial',
    note: 'Population, area and density retrieved for 24 states and the national total of 1,210,854,977. The listing was truncated before the smaller states and union territories, so those carry allocated populations rather than read ones.',
  },
  {
    id: 'nlem2022',
    title: 'National List of Essential Medicines 2022',
    publisher: 'Central Drugs Standard Control Organisation, Ministry of Health and Family Welfare',
    url: 'https://cdsco.gov.in/opencms/resources/UploadCDSCOWeb/2018/UploadConsumer/nlem2022.pdf',
    licence: 'Government of India publication, retrieved and parsed for reference values',
    retrievedOn: RETRIEVED_ON,
    status: 'partial',
    note: 'PDF retrieved and parsed locally. Section codes, generic names, level-of-care markers (P/S/T) and dosage forms were extracted; 203 entries carry a primary-level marker. Oral Rehydration Salts are absent from the parsed text and so are absent from the catalogue — a recorded gap, not a substitution.',
  },
  {
    id: 'iphs-subcentre',
    title: 'Indian Public Health Standards — sub-centre population norm (5,000 in plain areas)',
    publisher: 'Cited in Kataria GM et al., Journal of Family Medicine and Primary Care, 2023',
    url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC10465053/',
    licence: 'Open access (CC BY-NC-SA); cited, not reproduced',
    retrievedOn: RETRIEVED_ON,
    status: 'partial',
    note: 'Secondary citation of IPHS 2012 rather than the standard itself: one sub-centre per 5,000 population in plain areas and 3,000 in hilly or difficult areas. Treated as sourced because it is a published citation, and flagged because the primary document was not retrieved.',
  },
  {
    id: 'iphs-phc',
    title: 'Indian Public Health Standards — primary health centre population norm',
    publisher: 'Indian Health Facility Guidelines (MoHFW-aligned reference)',
    url: 'https://india.healthfacilityguidelines.com/Guidelines/ViewPDF/HFG-India/part_a_introduction',
    licence: 'Government of India reference material; ranges cited, not reproduced',
    retrievedOn: RETRIEVED_ON,
    status: 'partial',
    note: 'A primary health centre covers 20,000 population in hilly, tribal or difficult areas and 30,000 elsewhere. Ranges agreed with a second independent listing, so the bands are treated as sourced; CHC norms (80,000–120,000) were not retrieved and remain an assumption.',
  },
  {
    id: 'lgd-directory',
    title: 'Local Government Directory — district and block codes',
    publisher: 'Ministry of Panchayati Raj, Government of India',
    url: 'https://lgdirectory.gov.in/',
    licence: 'Government of India directory',
    retrievedOn: RETRIEVED_ON,
    status: 'failed',
    note: 'The portal loaded, but the district code table is served through an interactive dashboard with no retrievable static listing. Official LGD codes are therefore NOT present anywhere in this dataset: every administrative identifier is prefixed SIM- and is synthetic.',
  },
  {
    id: 'idsp-syndromes',
    title: 'Integrated Disease Surveillance Programme syndrome taxonomy',
    publisher: 'National Centre for Disease Control, Ministry of Health and Family Welfare',
    url: 'https://idsp.mohfw.gov.in/',
    licence: 'Government of India',
    retrievedOn: RETRIEVED_ON,
    status: 'failed',
    note: 'Not retrieved in this run. The syndrome list in the domain model is a plausible clinical grouping (fever, cough, diarrhoea, rash, jaundice, conjunctivitis, bleeding, neurological) and is documented as an assumption rather than as the programme taxonomy.',
  },
  {
    id: 'rhs-facility-counts',
    title: 'Rural Health Statistics — facility counts by state',
    publisher: 'Ministry of Health and Family Welfare',
    url: 'https://main.mohfw.gov.in/',
    licence: 'Government of India',
    retrievedOn: RETRIEVED_ON,
    status: 'failed',
    note: 'Not retrieved in this run. Facility counts per district are derived from population and the IPHS norms above rather than read from a published count, and every derived count is marked as such.',
  },
];

export const SOURCE_BY_ID: ReadonlyMap<string, SourceRecord> = new Map(
  SOURCES.map((source) => [source.id, source]),
);

/** Fails loudly rather than letting a record cite a source that does not exist. */
export const requireSource = (id: string): SourceRecord => {
  const source = SOURCE_BY_ID.get(id);
  if (source === undefined) {
    throw new Error(`unknown source: ${id}`);
  }
  return source;
};

/** The date every anchored value in this build was retrieved. */
export const RETRIEVAL_DATE = RETRIEVED_ON;
