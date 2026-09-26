import { CivoraError } from '@civora/domain';
import { describe, expect, it } from 'vitest';

import {
  LGD_FIELD_MAPPING,
  crosswalk,
  lgdDistrictId,
  normalisedName,
  parseLgdExtract,
} from './lgd';

/**
 * The administrative directory, parsed from a document rather than a typed value.
 *
 * Three claims: the shape the published directory exports to is read; the
 * crosswalk joins by name in both directions and **reports what did not join**,
 * which is the part a deployment needs before a reporting deadline rather than
 * after; and the field mapping names every field the reader reads, so the
 * documentation cannot drift from the code.
 */

const EXTRACT: unknown = {
  sourceId: 'lgd-demo',
  title: 'Local Government Directory — administrative units',
  retrievedOn: '2026-08-01',
  units: [
    {
      stateCode: '10',
      stateName: 'Bihar',
      districtCode: '236',
      districtName: 'Gaya',
      subdistrictCode: '1666',
      subdistrictName: 'Gaya Sadar',
    },
    {
      stateCode: '10',
      stateName: 'Bihar',
      districtCode: '236',
      districtName: 'Gaya',
      subdistrictCode: '1667',
      subdistrictName: 'Sherghati',
    },
    {
      stateCode: '10',
      stateName: 'Bihar',
      districtCode: '230',
      districtName: 'Patna',
      subdistrictCode: '1401',
      subdistrictName: 'Patna Sadar',
    },
    {
      stateCode: '21',
      stateName: 'Odisha',
      districtCode: '370',
      districtName: 'Khordha',
      subdistrictCode: '2901',
      subdistrictName: 'Bhubaneswar',
    },
  ],
};

const imported = parseLgdExtract(EXTRACT);

/** Two of the four government districts exist on the platform, with different case. */
const DISTRICTS = [
  { id: 'SIM-BIHAR-GAYA', name: 'GAYA', regionId: 'SIM-BIHAR' },
  { id: 'SIM-BIHAR-PATNA', name: 'patna', regionId: 'SIM-BIHAR' },
  { id: 'SIM-BIHAR-NAWADA', name: 'Nawada', regionId: 'SIM-BIHAR' },
] as const;

describe('the administrative directory', () => {
  it('reads the extract, keeping the state code as the two characters it is', () => {
    expect(imported.sourceId).toBe('lgd-demo');
    expect(imported.units).toHaveLength(4);
    expect(imported.units[0]?.stateCode).toBe('10');
  });

  it('refuses a document it does not recognise, naming the field', () => {
    expect(() => parseLgdExtract({ sourceId: 'x' })).toThrow(CivoraError);

    // A state code of one digit is a code that lost its leading zero to a
    // spreadsheet, which is the most ordinary way a directory arrives damaged.
    expect(() =>
      parseLgdExtract({
        sourceId: 'lgd-demo',
        title: 'Local Government Directory — administrative units',
        retrievedOn: '2026-08-01',
        units: [
          {
            stateCode: '1',
            stateName: 'Bihar',
            districtCode: '236',
            districtName: 'Gaya',
            subdistrictCode: '1666',
            subdistrictName: 'Gaya Sadar',
          },
        ],
      }),
    ).toThrow(/a state code is two digits/);
  });
});

describe('the crosswalk to the platform’s own districts', () => {
  const walked = crosswalk(imported, DISTRICTS);

  it('joins by normalised name, whatever case either side is written in', () => {
    expect(walked.codes.map((entry) => entry.districtId)).toEqual([
      'SIM-BIHAR-GAYA',
      'SIM-BIHAR-PATNA',
    ]);
    expect(walked.codes[0]?.districtCode).toBe('236');
    expect(walked.codes[1]?.districtCode).toBe('230');
  });

  it('carries every sub-district of a matched district as its blocks', () => {
    expect(walked.codes[0]?.subdistricts).toEqual([
      { code: '1666', name: 'Gaya Sadar' },
      { code: '1667', name: 'Sherghati' },
    ]);
  });

  it('reports what did not join, in both directions', () => {
    // A government district the platform has nothing for, and a platform district
    // the directory does not name. Both are reported because both are somebody's
    // problem before a return is due, and a crosswalk that silently covered two
    // thirds of the country would look built.
    expect(walked.unmatchedGovernment).toEqual(['Odisha · Khordha']);
    expect(walked.unmatchedPlatform).toEqual(['Nawada']);
  });

  it('names the identifier a deployment builds from the codes', () => {
    expect(lgdDistrictId('10', '236')).toBe('lgd-10-236');
  });

  it('normalises names without inventing aliases', () => {
    expect(normalisedName('  GAYA  Sadar ')).toBe('gaya sadar');
    // A renamed district is a different string; the crosswalk reports it rather
    // than deciding that two names are the same place.
    expect(normalisedName('Chhatrapati Sambhajinagar')).not.toBe(normalisedName('Aurangabad'));
  });
});

describe('the documented correspondence', () => {
  it('names every field of a directory row', () => {
    const row = imported.units[0];
    expect(row).toBeDefined();
    if (row === undefined) {
      return;
    }

    // Every field the reader accepts is either in the published columns or
    // derived, and this asserts the first half: the mapping is a table a reviewer
    // reads in `docs/INTEROP.md`, and it cannot silently lose a column.
    const mapped = new Set(LGD_FIELD_MAPPING.map((entry) => entry.target.split('.').at(-1)));
    for (const field of Object.keys(row)) {
      expect(mapped.has(field), `${field} is read but not documented`).toBe(true);
    }
    expect(LGD_FIELD_MAPPING.length).toBe(Object.keys(row).length);
  });
});
