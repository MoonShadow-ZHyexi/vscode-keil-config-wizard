const { parseInteger } = require('./integer-literals');

const namePattern = /^[A-Za-z_$][\w$]*$/;
const literal = /^(?:"(?:\\.|[^"\\\r\n])*"|[+-]?(?:&[\da-fA-F]|\d|\.\d)(?:[eEpP][+-]|[\w$.'])*|[A-Za-z_$][\w$]*)/;
const trivia = /^(?:\s+|\\\r?\n|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/)*/;
const macroPadding = /^(?:[\t ]+|\\\r?\n|\/\*[\s\S]*?\*\/)*/;
const macroPrefix = /^[\t ]*#[\t ]*define[\t ]+$/;

function lineStart(source, offset) {
  return source.lastIndexOf('\n', offset - 1) + 1;
}

function afterLine(source, offset) {
  const end = source.indexOf('\n', offset);
  return end < 0 ? source.length : end + 1;
}

function prefixOfLine(source, offset) {
  return source.slice(lineStart(source, offset), offset);
}

function namedValueStart(source, nameOffset, name) {
  const afterName = nameOffset + name.length;
  const following = source.slice(afterName);
  // An adjacent parenthesis starts a function-like macro and is not its value.
  if (macroPrefix.test(prefixOfLine(source, nameOffset))) {
    if (following.startsWith('(')) return;
    const padding = macroPadding.exec(following)[0].length;
    // A macro without a value must not bind a token on the next source line.
    if (!padding || /^(?:\r?\n|\/\/|$)/.test(following.slice(padding))) return;
    return afterName + padding;
  }
  const assignment = /^(?:[\t ]*\[[^\]\r\n]*\])*[\t ]*(?:=(?!=)|EQU\b)/i.exec(following);
  return assignment ? afterName + assignment[0].length : undefined;
}

function readArray(source, offset, assembly) {
  if (source[offset] !== '{') return;
  const elements = [];
  let cursor = offset + 1;
  while (elements.length < 65) {
    cursor += trivia.exec(source.slice(cursor))[0].length;
    if (source[cursor] === '}') return { offset, raw: source.slice(offset, cursor + 1), elements };
    const raw = literal.exec(source.slice(cursor))?.[0];
    const numeric = raw && parseInteger(raw, assembly);
    if (!numeric) return;
    elements.push({ start: cursor - offset, raw, numeric });
    cursor += raw.length + trivia.exec(source.slice(cursor + raw.length))[0].length;
    if (source[cursor] === '}') return { offset, raw: source.slice(offset, cursor + 1), elements };
    if (source[cursor] !== ',') return;
    cursor++;
  }
}

function readValue(source, start, row) {
  let offset = start + trivia.exec(source.slice(start))[0].length;
  if (row.type === 'a') {
    if (source[offset] !== '{' && !row.name) return;
    const array = readArray(source, offset, row.assembly);
    // A mismatched target must not fall through to a later, unrelated array.
    if (!array || array.elements.length !== Number(row.low)) {
      return { issue: '目标须为包含 ' + row.low + ' 个整数字面量的数组。' };
    }
    return array;
  }

  let parentheses = 0;
  while (source[offset] === '(') {
    offset++;
    parentheses++;
    offset += /^[\t ]*/.exec(source.slice(offset))[0].length;
  }
  // Keep a wide or UTF string's prefix in the source while editing its literal.
  if (row.type === 's') offset += /^(?:u8|[LuU])(?=")/.exec(source.slice(offset))?.[0].length ?? 0;
  const raw = literal.exec(source.slice(offset))?.[0];
  if (!raw) return { issue: '目标缺少可编辑的值。' };
  const numeric = parseInteger(raw, row.assembly);
  const valid = row.type === 's' ? raw.startsWith('"') :
    Boolean(numeric) || ((row.type === 'y' || (row.type === 'o' && row.name)) && namePattern.test(raw));
  const tail = source.slice(offset + raw.length, afterLine(source, offset)).trim();
  const closes = new RegExp('^(?:[\\t ]*\\)){' + parentheses + '}[\\t ]*');
  const closing = closes.exec(tail);
  if (!valid || !closing || !/^(?:;[\t ]*)?(?:\/\/.*|\/\*.*\*\/[\t ]*|;.*)?$/.test(tail.slice(closing[0].length))) {
    return { issue: '目标须为单个字面量或符号。' };
  }
  return { raw, offset, numeric };
}

function readCodeBlock(source, opening, closing, row) {
  let offset = afterLine(source, opening);
  const end = lineStart(source, closing);
  for (let skipped = 0; skipped < row.skip && offset < end; skipped++) offset = afterLine(source, offset);
  // Leading help and defaults remain annotations even with a zero skip.
  while (offset < end && /^[\t ]*(?:\/\/|;)[\t ]*<(?:i|d)>/.test(source.slice(offset, afterLine(source, offset)))) {
    offset = afterLine(source, offset);
  }
  const raw = source.slice(offset, end);
  const lines = raw.split(/\r?\n/).map(line => line.trimStart()).filter(Boolean);
  const commented = lines.filter(line => line.startsWith(row.comment)).length;
  if (!lines.length) return { issue: '代码块为空。' };
  if (commented && commented < lines.length) return { issue: '代码块混有已注释和未注释的行。' };
  return { raw, offset, commented: commented > 0 };
}

function replaceCodeBlock(row, value) {
  const commented = row.inverse ? value === '1' : value === '0';
  if (commented === row.commented) return row.raw;
  // Edit just the first comment marker and keep the original line endings.
  return row.raw.replace(/[^\r\n]*\r?\n|[^\r\n]+$/g, line => {
    const indent = /^[\t ]*/.exec(line)[0].length;
    if (commented) return line.slice(0, indent) + row.comment + line.slice(indent);
    if (line.startsWith(row.comment, indent)) return line.slice(0, indent) + line.slice(indent + row.comment.length);
    return line;
  });
}

module.exports = { namePattern, namedValueStart, readCodeBlock, readValue, replaceCodeBlock };
