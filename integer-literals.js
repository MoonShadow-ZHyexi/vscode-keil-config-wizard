const typedSuffix = /^(?:[uU](?:ll|LL|[lLzZ]|wb|WB)?|(?:ll|LL|[lLzZ]|wb|WB)[uU]?)?$/;
const prefixes = { x: 16, b: 2, o: 8 };
const suffixes = { h: 16, b: 2, y: 2, o: 8, q: 8, d: 10, t: 10 };
const digitsByValue = '0123456789abcdef';

function parseInteger(text, assembly) {
  const sign = /^[+-]/.test(text) ? text[0] : '';
  const unsigned = text.slice(sign.length);
  if (!assembly && /^0[bo]$/i.test(unsigned)) return;
  const trailing = /^(\d(?:['_]?[0-9a-f])*)([hbyoqdt])$/i.exec(unsigned);
  const leading = trailing ? null : /^(0[xbo]|&)(?=[\da-f])/i.exec(unsigned) ?? (assembly && /^[2-9]_/.exec(unsigned));
  const prefix = leading?.[0] ?? '';
  const suffix = trailing?.[2] ?? '';
  const radixDigits = trailing?.[1] ?? unsigned.slice(prefix.length);
  const match = /^([0-9a-f](?:['_]?[0-9a-f])*)(.*)$/i.exec(radixDigits);
  if (!match || !typedSuffix.test(match[2]) || (suffix && match[2])) return;

  const [, digits, typeSuffix] = match;
  const compact = digits.replace(/['_]/g, '');
  const implicitOctal = !assembly && !prefix && !suffix && /^0[0-7]+$/.test(compact);
  const radix = prefix === '&' ? 16 : prefix.endsWith('_') ? Number(prefix[0])
    : prefixes[prefix[1]?.toLowerCase()] ?? suffixes[suffix.toLowerCase()] ?? (implicitOctal ? 8 : 10);

  let value = 0n;
  const base = BigInt(radix);
  for (const digit of compact.toLowerCase()) {
    const index = digitsByValue.indexOf(digit);
    if (index < 0 || index >= radix) return;
    value = value * base + BigInt(index);
  }
  return { value: sign === '-' ? -value : value, sign, prefix, digits, suffix, typeSuffix, radix, implicitOctal };
}

function formatInteger(value, original, preserveWidth = true) {
  const { sign, prefix, suffix, typeSuffix, radix, implicitOctal } = original;
  let digits = (value < 0n ? -value : value).toString(radix);
  if (prefix === '0X' || suffix === 'H' || /[A-F]/.test(original.digits)) digits = digits.toUpperCase();
  if (preserveWidth && radix !== 10) {
    digits = digits.padStart(original.digits.replace(/['_]/g, '').length, '0');
  }
  if ((implicitOctal && !digits.startsWith('0')) || (/^h$/i.test(suffix) && /^[a-f]/i.test(digits))) {
    digits = '0' + digits;
  }
  if (preserveWidth) {
    const groups = original.digits.split(/(['_])/);
    let formatted = '';
    for (let index = groups.length - 1; index > 0; index -= 2) {
      const position = digits.length - groups[index].length;
      if (position <= 0) break;
      formatted = groups[index - 1] + digits.slice(position) + formatted;
      digits = digits.slice(0, position);
    }
    digits += formatted;
  }
  return (value < 0n ? '-' : sign === '+' ? '+' : '') + prefix + digits + suffix + (preserveWidth ? typeSuffix : '');
}

module.exports = { parseInteger, formatInteger };
