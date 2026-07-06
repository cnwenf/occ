// 2.1.144: /extra-usage was renamed to /usage-credits. This stub delegates to
// the real /usage-credits non-interactive command and prepends a rename notice,
// mirroring the official Ykf non-interactive stub.
const RENAME_NOTICE = '/extra-usage is now /usage-credits';

export async function call(): Promise<{ type: 'text'; value: string }> {
  const { call: realCall } = await import(
    '../usage-credits/usage-credits-noninteractive.js'
  );
  const t = await realCall();
  return { type: 'text', value: `${RENAME_NOTICE}\n${t.value}` };
}
