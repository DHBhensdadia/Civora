/**
 * The administrative spine the dataset is built on.
 *
 * Three kinds of value live here, and every one of them is labelled:
 *
 *  - **Read values** — state and district populations taken from the Census of
 *    India 2011 listing recorded in `sources.ts`, used verbatim.
 *  - **Allocated values** — states the source listing was truncated before, and
 *    districts of the four states whose district tables were not retrieved.
 *    Their names are real administrative units; their populations come from a
 *    documented band or a documented share, and the records carry an
 *    `assumption` provenance so nothing downstream can mistake them for census
 *    figures.
 *  - **Generated values** — districts for states whose district tables do not
 *    exist here. They are named after their state and numbered, which is
 *    deliberately obvious rather than plausibly real.
 *
 * Official LGD codes are absent throughout: the directory was not retrievable
 * (see `sources.ts`), and inventing a code in a field called `lgdCode` is the
 * one thing this file must not do, so every identifier is prefixed `SIM-`.
 */

export type Anchoring = 'census' | 'allocated' | 'generated';

export interface StateAnchor {
  readonly name: string;
  /** BCP-47 tag of the state's primary language, for localised advisories. */
  readonly language: string;
  readonly population: number;
  readonly populationSourceId: string;
  readonly populationAnchoring: Anchoring;
  /** Share of the population living in urban areas; an assumption, see the table. */
  readonly urbanShare: number;
  /** How reliably the state's facilities reach the network. */
  readonly connectivity: 'good' | 'intermittent' | 'poor';
}

/** A district whose population was read from the census listing. */
export interface CensusDistrict {
  readonly name: string;
  readonly population: number;
}

/** A district whose name is real but whose population is allocated by band. */
export interface NamedDistrict {
  readonly name: string;
}

interface StateWithDistricts extends StateAnchor {
  readonly districtAnchoring: Anchoring;
  /** Census districts, or real names awaiting an allocated population. */
  readonly districts: readonly (CensusDistrict | NamedDistrict)[];
}

const censusDistrict = (name: string, population: number): CensusDistrict => ({ name, population });

/**
 * The six states the demo profile covers.
 *
 * Chosen for contrast rather than convenience: a large low-capacity state, a
 * high-density state, a high-capacity southern state, an industrial western
 * state, and two eastern states. A network that behaves plausibly across these
 * behaves plausibly across the country.
 */
export const DEMO_STATES: readonly StateWithDistricts[] = [
  {
    name: 'Odisha',
    language: 'or',
    population: 41_974_218,
    populationSourceId: 'census2011-states',
    populationAnchoring: 'census',
    urbanShare: 0.167,
    connectivity: 'poor',
    districtAnchoring: 'census',
    districts: [
      censusDistrict('Ganjam', 3_529_031),
      censusDistrict('Cuttack', 2_624_470),
      censusDistrict('Mayurbhanj', 2_519_738),
      censusDistrict('Baleshwar', 2_320_529),
      censusDistrict('Khordha', 2_251_673),
      censusDistrict('Sundargarh', 2_093_437),
      censusDistrict('Jajapur', 1_827_192),
      censusDistrict('Kendujhar', 1_801_733),
      censusDistrict('Puri', 1_698_730),
      censusDistrict('Balangir', 1_648_997),
      censusDistrict('Kalahandi', 1_576_869),
      censusDistrict('Bhadrak', 1_506_337),
      censusDistrict('Bargarh', 1_481_255),
      censusDistrict('Kendrapara', 1_440_361),
      censusDistrict('Koraput', 1_379_647),
      censusDistrict('Anugul', 1_273_821),
      censusDistrict('Nabarangapur', 1_220_946),
      censusDistrict('Dhenkanal', 1_192_811),
      censusDistrict('Jagatsinghapur', 1_136_971),
      censusDistrict('Sambalpur', 1_041_099),
      censusDistrict('Rayagada', 967_911),
      censusDistrict('Nayagarh', 962_789),
      censusDistrict('Kandhamal', 733_110),
      censusDistrict('Malkangiri', 613_192),
      censusDistrict('Nuapada', 610_382),
      censusDistrict('Subarnapur', 610_183),
      censusDistrict('Jharsuguda', 579_505),
      censusDistrict('Gajapati', 577_817),
      censusDistrict('Baudh', 441_162),
      censusDistrict('Debagarh', 312_520),
    ],
  },
  {
    name: 'Bihar',
    language: 'hi',
    population: 104_099_452,
    populationSourceId: 'census2011-states',
    populationAnchoring: 'census',
    urbanShare: 0.113,
    connectivity: 'poor',
    districtAnchoring: 'census',
    districts: [
      censusDistrict('Patna', 5_838_465),
      censusDistrict('Purbi Champaran', 5_099_371),
      censusDistrict('Muzaffarpur', 4_801_062),
      censusDistrict('Madhubani', 4_487_379),
      censusDistrict('Gaya', 4_391_418),
      censusDistrict('Samastipur', 4_261_566),
      censusDistrict('Saran', 3_951_862),
      censusDistrict('Darbhanga', 3_937_385),
      censusDistrict('Pashchim Champaran', 3_935_042),
      censusDistrict('Vaishali', 3_495_021),
      censusDistrict('Sitamarhi', 3_423_574),
      censusDistrict('Siwan', 3_330_464),
      censusDistrict('Purnia', 3_264_619),
      censusDistrict('Katihar', 3_071_029),
      censusDistrict('Bhagalpur', 3_037_766),
      censusDistrict('Begusarai', 2_970_541),
      censusDistrict('Rohtas', 2_959_918),
      censusDistrict('Nalanda', 2_877_653),
      censusDistrict('Araria', 2_811_569),
      censusDistrict('Bhojpur', 2_728_407),
      censusDistrict('Gopalganj', 2_562_012),
      censusDistrict('Aurangabad', 2_540_073),
      censusDistrict('Supaul', 2_229_076),
      censusDistrict('Nawada', 2_219_146),
      censusDistrict('Banka', 2_034_763),
      censusDistrict('Madhepura', 2_001_762),
      censusDistrict('Saharsa', 1_900_661),
      censusDistrict('Jamui', 1_760_405),
      censusDistrict('Buxar', 1_706_352),
      censusDistrict('Kishanganj', 1_690_400),
      censusDistrict('Khagaria', 1_666_886),
      censusDistrict('Kaimur', 1_626_384),
      censusDistrict('Munger', 1_367_765),
      censusDistrict('Jehanabad', 1_125_313),
      censusDistrict('Lakhisarai', 1_000_912),
      censusDistrict('Arwal', 700_843),
      censusDistrict('Sheohar', 656_246),
      censusDistrict('Sheikhpura', 636_342),
    ],
  },
  {
    name: 'Maharashtra',
    language: 'mr',
    population: 112_374_333,
    populationSourceId: 'census2011-states',
    populationAnchoring: 'census',
    urbanShare: 0.455,
    connectivity: 'good',
    districtAnchoring: 'allocated',
    districts: [{ name: 'Pune' }, { name: 'Nashik' }, { name: 'Nagpur' }],
  },
  {
    name: 'Tamil Nadu',
    language: 'ta',
    population: 72_147_030,
    populationSourceId: 'census2011-states',
    populationAnchoring: 'census',
    urbanShare: 0.484,
    connectivity: 'good',
    districtAnchoring: 'allocated',
    districts: [{ name: 'Chennai' }, { name: 'Coimbatore' }, { name: 'Madurai' }],
  },
  {
    name: 'Kerala',
    language: 'ml',
    population: 33_406_061,
    populationSourceId: 'census2011-states',
    populationAnchoring: 'census',
    urbanShare: 0.475,
    connectivity: 'good',
    districtAnchoring: 'allocated',
    districts: [{ name: 'Thiruvananthapuram' }, { name: 'Ernakulam' }, { name: 'Kozhikode' }],
  },
  {
    name: 'Uttar Pradesh',
    language: 'hi',
    population: 199_812_341,
    populationSourceId: 'census2011-states',
    populationAnchoring: 'census',
    urbanShare: 0.223,
    connectivity: 'intermittent',
    districtAnchoring: 'allocated',
    districts: [{ name: 'Lucknow' }, { name: 'Varanasi' }, { name: 'Kanpur Nagar' }],
  },
];

/**
 * The remaining states read from the census listing, which supplies their
 * populations but not their districts.
 */
export const EXTRA_ANCHORED_STATES: readonly StateAnchor[] = [
  {
    name: 'West Bengal',
    language: 'bn',
    population: 91_276_115,
    populationSourceId: 'census2011-states',
    populationAnchoring: 'census',
    urbanShare: 0.318,
    connectivity: 'intermittent',
  },
  {
    name: 'Andhra Pradesh',
    language: 'te',
    population: 84_580_777,
    populationSourceId: 'census2011-states',
    populationAnchoring: 'census',
    urbanShare: 0.295,
    connectivity: 'intermittent',
  },
  {
    name: 'Madhya Pradesh',
    language: 'hi',
    population: 72_626_809,
    populationSourceId: 'census2011-states',
    populationAnchoring: 'census',
    urbanShare: 0.277,
    connectivity: 'poor',
  },
  {
    name: 'Rajasthan',
    language: 'hi',
    population: 68_548_437,
    populationSourceId: 'census2011-states',
    populationAnchoring: 'census',
    urbanShare: 0.243,
    connectivity: 'poor',
  },
  {
    name: 'Karnataka',
    language: 'kn',
    population: 61_095_297,
    populationSourceId: 'census2011-states',
    populationAnchoring: 'census',
    urbanShare: 0.381,
    connectivity: 'good',
  },
  {
    name: 'Gujarat',
    language: 'gu',
    population: 60_439_692,
    populationSourceId: 'census2011-states',
    populationAnchoring: 'census',
    urbanShare: 0.428,
    connectivity: 'good',
  },
  {
    name: 'Jharkhand',
    language: 'hi',
    population: 32_988_134,
    populationSourceId: 'census2011-states',
    populationAnchoring: 'census',
    urbanShare: 0.242,
    connectivity: 'poor',
  },
  {
    name: 'Assam',
    language: 'as',
    population: 31_205_576,
    populationSourceId: 'census2011-states',
    populationAnchoring: 'census',
    urbanShare: 0.143,
    connectivity: 'poor',
  },
  {
    name: 'Punjab',
    language: 'pa',
    population: 27_743_338,
    populationSourceId: 'census2011-states',
    populationAnchoring: 'census',
    urbanShare: 0.375,
    connectivity: 'good',
  },
  {
    name: 'Chhattisgarh',
    language: 'hi',
    population: 25_545_198,
    populationSourceId: 'census2011-states',
    populationAnchoring: 'census',
    urbanShare: 0.233,
    connectivity: 'poor',
  },
  {
    name: 'Haryana',
    language: 'hi',
    population: 25_351_462,
    populationSourceId: 'census2011-states',
    populationAnchoring: 'census',
    urbanShare: 0.348,
    connectivity: 'good',
  },
  {
    name: 'Delhi',
    language: 'hi',
    population: 16_787_941,
    populationSourceId: 'census2011-states',
    populationAnchoring: 'census',
    urbanShare: 0.975,
    connectivity: 'good',
  },
  {
    name: 'Jammu and Kashmir',
    language: 'ur',
    population: 12_541_302,
    populationSourceId: 'census2011-states',
    populationAnchoring: 'census',
    urbanShare: 0.271,
    connectivity: 'poor',
  },
  {
    name: 'Uttarakhand',
    language: 'hi',
    population: 10_086_292,
    populationSourceId: 'census2011-states',
    populationAnchoring: 'census',
    urbanShare: 0.305,
    connectivity: 'poor',
  },
  {
    name: 'Himachal Pradesh',
    language: 'hi',
    population: 6_864_602,
    populationSourceId: 'census2011-states',
    populationAnchoring: 'census',
    urbanShare: 0.1,
    connectivity: 'intermittent',
  },
  {
    name: 'Tripura',
    language: 'bn',
    population: 3_673_917,
    populationSourceId: 'census2011-states',
    populationAnchoring: 'census',
    urbanShare: 0.264,
    connectivity: 'intermittent',
  },
  {
    name: 'Meghalaya',
    language: 'en',
    population: 2_966_889,
    populationSourceId: 'census2011-states',
    populationAnchoring: 'census',
    urbanShare: 0.201,
    connectivity: 'poor',
  },
  {
    name: 'Sikkim',
    language: 'ne',
    population: 607_688,
    populationSourceId: 'census2011-states',
    populationAnchoring: 'census',
    urbanShare: 0.253,
    connectivity: 'poor',
  },
];

/**
 * States and union territories the census listing was truncated before.
 *
 * Their populations are allocated from the residual of the national total and
 * a documented size class, because the alternative — writing a remembered
 * figure into a field that reads as census data — is worse than an allocated
 * one that announces itself as allocated.
 *
 * Two notes for a careful reader. The 2026 administrative map has 36 states and
 * union territories; the 2011 census predates the bifurcation of several of
 * them, so no single census figure exists for those units as they are drawn
 * today. And the allocated shares are shares of a real national total, so the
 * country-level figure stays correct while the state split does not.
 */
export const ALLOCATED_STATES: readonly StateAnchor[] = [
  {
    name: 'Telangana',
    language: 'te',
    population: 0,
    populationSourceId: 'census2011-states',
    populationAnchoring: 'allocated',
    urbanShare: 0.389,
    connectivity: 'intermittent',
  },
  {
    name: 'Goa',
    language: 'kok',
    population: 0,
    populationSourceId: 'census2011-states',
    populationAnchoring: 'allocated',
    urbanShare: 0.622,
    connectivity: 'good',
  },
  {
    name: 'Arunachal Pradesh',
    language: 'en',
    population: 0,
    populationSourceId: 'census2011-states',
    populationAnchoring: 'allocated',
    urbanShare: 0.227,
    connectivity: 'poor',
  },
  {
    name: 'Manipur',
    language: 'mni',
    population: 0,
    populationSourceId: 'census2011-states',
    populationAnchoring: 'allocated',
    urbanShare: 0.3,
    connectivity: 'poor',
  },
  {
    name: 'Mizoram',
    language: 'lus',
    population: 0,
    populationSourceId: 'census2011-states',
    populationAnchoring: 'allocated',
    urbanShare: 0.452,
    connectivity: 'poor',
  },
  {
    name: 'Nagaland',
    language: 'en',
    population: 0,
    populationSourceId: 'census2011-states',
    populationAnchoring: 'allocated',
    urbanShare: 0.289,
    connectivity: 'poor',
  },
  {
    name: 'Puducherry',
    language: 'ta',
    population: 0,
    populationSourceId: 'census2011-states',
    populationAnchoring: 'allocated',
    urbanShare: 0.683,
    connectivity: 'good',
  },
  {
    name: 'Chandigarh',
    language: 'hi',
    population: 0,
    populationSourceId: 'census2011-states',
    populationAnchoring: 'allocated',
    urbanShare: 0.974,
    connectivity: 'good',
  },
  {
    name: 'Ladakh',
    language: 'en',
    population: 0,
    populationSourceId: 'census2011-states',
    populationAnchoring: 'allocated',
    urbanShare: 0.1,
    connectivity: 'poor',
  },
  {
    name: 'Andaman and Nicobar Islands',
    language: 'en',
    population: 0,
    populationSourceId: 'census2011-states',
    populationAnchoring: 'allocated',
    urbanShare: 0.359,
    connectivity: 'poor',
  },
  {
    name: 'Dadra and Nagar Haveli and Daman and Diu',
    language: 'gu',
    population: 0,
    populationSourceId: 'census2011-states',
    populationAnchoring: 'allocated',
    urbanShare: 0.553,
    connectivity: 'good',
  },
  {
    name: 'Lakshadweep',
    language: 'ml',
    population: 0,
    populationSourceId: 'census2011-states',
    populationAnchoring: 'allocated',
    urbanShare: 0.781,
    connectivity: 'poor',
  },
];

/** The national total, read from the census listing rather than summed. */
export const NATIONAL_POPULATION = 1_210_854_977;
export const NATIONAL_POPULATION_SOURCE_ID = 'census2011-states';

/**
 * Relative size of an allocated state, used to divide the residual population.
 *
 * A weight, not a figure: the weights are documented in the assumptions table
 * and their only job is to distribute the residual in a defensible shape
 * instead of evenly.
 */
export const ALLOCATED_STATE_WEIGHTS: Readonly<Record<string, number>> = {
  Telangana: 10,
  Goa: 0.6,
  'Arunachal Pradesh': 0.5,
  Manipur: 1,
  Mizoram: 0.4,
  Nagaland: 0.8,
  Puducherry: 0.5,
  Chandigarh: 0.4,
  Ladakh: 0.1,
  'Andaman and Nicobar Islands': 0.15,
  'Dadra and Nagar Haveli and Daman and Diu': 0.3,
  Lakshadweep: 0.03,
};

/** A URL- and identifier-safe form of a name, so ids are derived rather than typed. */
export const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
