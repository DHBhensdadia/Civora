/**
 * The sample register page, as HTML — one source for two consumers.
 *
 * `scripts/make-sample-register.mjs` renders it with a fixed date and commits the
 * PNG as the sample a person can try the reader on, and `e2e/live-ai.spec.ts`
 * renders the same page dated **today** so the line the model reads lands in the
 * facility's visible record window rather than at the start of the month.
 *
 * The rows are the register's whole content. They are written the way a paper
 * register writes them — name, strength and form as one string, a batch number,
 * a month/year expiry, and received/issued/balance columns — because the reader
 * has to transcribe what is on the page rather than tidy it, and the platform
 * matches the names itself.
 */

/** One row: serial, medicine, batch, expiry, received, issued, balance. */
export const REGISTER_ROWS: readonly (readonly string[])[] = [
  ['1', 'Paracetamol 500 mg Tab', 'PCM-2291', '12/2027', '137', '00', '137'],
  ['2', 'Amoxicillin 500 mg Cap', 'AMX-1180', '06/2027', '60', '12', '48'],
  ['3', 'ORS Powder', 'ORS-441', '03/2028', '200', '35', '165'],
  ['4', 'Metformin 500 mg Tab', 'MET-9031', '09/2027', '90', '00', '90'],
  ['5', 'Ibuprofen 400 mg Tab', 'IBU-556', '01/2028', '45', '05', '40'],
];

const tableRows = REGISTER_ROWS.map(
  ([serial, medicine, batch, expiry, received, issued, balance]) =>
    `<tr><td>${serial ?? ''}</td><td class="medicine">${medicine ?? ''}</td><td>${batch ?? ''}</td><td>${expiry ?? ''}</td><td>${received ?? ''}</td><td>${issued ?? ''}</td><td>${balance ?? ''}</td></tr>`,
).join('\n');

/** What the page states above the table. */
export interface RegisterPageInput {
  /** The day the register describes, stated on the page rather than inferred. */
  readonly date: string;
  readonly heading: string;
}

/**
 * The page.
 *
 * `date` is stated on the page rather than left to the reader to infer: a
 * register that names its day is one the platform can date a movement by, and the
 * live check relies on that instead of assuming the month's first day.
 */
export function registerPageHtml(input: RegisterPageInput): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <style>
      @page { size: A4; margin: 12mm; }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background: #ffffff;
        color: #16181d;
        font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
        font-size: 15px;
      }
      .sheet { width: 720px; padding: 28px 30px; }
      h1 { margin: 0; font-size: 21px; letter-spacing: 0.4px; }
      .sub { margin: 4px 0 18px; font-size: 13px; color: #444a55; }
      table { width: 100%; border-collapse: collapse; }
      th, td {
        border: 1px solid #2b3038;
        padding: 7px 8px;
        text-align: left;
        font-size: 14px;
      }
      th { background: #eceef2; font-weight: 600; }
      td.medicine { min-width: 210px; }
      td { font-variant-numeric: tabular-nums; }
      .rule { margin-top: 26px; border-top: 1px solid #9aa0aa; padding-top: 8px; font-size: 12px; color: #555b66; }
    </style>
  </head>
  <body>
    <div class="sheet">
      <h1>${input.heading}</h1>
      <p class="sub">Primary Health Centre · Date: ${input.date} · all quantities in units</p>
      <table>
        <thead>
          <tr>
            <th>S. No</th>
            <th>Name of medicine</th>
            <th>Batch No</th>
            <th>Expiry</th>
            <th>Received</th>
            <th>Issued</th>
            <th>Balance</th>
          </tr>
        </thead>
        <tbody>
${tableRows}
        </tbody>
      </table>
      <div class="rule">Signature of the pharmacist: ______________________</div>
    </div>
  </body>
</html>`;
}
