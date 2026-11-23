const { parseInteger, formatInteger } = require('./integer-literals');
const { createConditionEvaluator, updateCondition } = require('./wizard-conditions');

const wizardStart = /<<<\s*Use Configuration Wizard in Context Menu\s*>>>/i;
const optionTag = /^([oqes])(\d*)(?:\.(\d+)(?:\.\.(\d+))?)?$/;
const choiceTag = /^([+-]?[\w'&]+)=$/;
const rangeTag = /^([+-]?[\w'&]+)-([+-]?[\w'&]+)(?::([+-]?[\w'&]+))?$/;
const conditionTags = new Set(['if', 'elif', 'else', 'endif']);
const cTokens = /\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[A-Za-z_$][\w$]*|[+-]?(?:\d|\.\d)(?:[eEpP][+-]|[\w$.'])*/g;
const asmTokens = new RegExp(/;[^\r\n]*|[+-]?&[\da-fA-F][\w$.']*/.source + '|' + cTokens.source, 'g');

function isAdjacentMacroValue(source, commentEnd, token) {
  const start = source.lastIndexOf('\n', token.index) + 1;
  if (commentEnd === undefined || commentEnd > start || /\S/.test(source.slice(commentEnd, start))) return false;
  const prefix = /^[\t ]*#[\t ]*define[\t ]+[A-Za-z_$][\w$]*[\t ]+(\([\t ]*)?$/.exec(source.slice(start, token.index));
  if (!prefix) return false;
  const end = source.indexOf('\n', token.index);
  let suffix = source.slice(token.index + token[0].length, end < 0 ? source.length : end).trim();
  if (prefix[1]) {
    if (!suffix.startsWith(')')) return false;
    suffix = suffix.slice(1).trimStart();
  }
  return /^(?:\/\*(?:[^*]|\*(?!\/))*\*\/[\t ]*)*(?:\/\/.*)?$/.test(suffix);
}

function parse(source, uri) {
  const marked = wizardStart.test(source);
  if (!marked && !/<[oqes][\d.]*>/.test(source)) return [];
  const assembly = /\.(?:s|asm|a51|a66|inc|src|ini)$/i.test(uri?.path ?? '');
  const tokens = assembly ? asmTokens : cTokens;
  const rows = [];
  const conditions = [];
  let evaluateCondition;
  let active = !marked;
  let current;
  let commentEnd;
  const pending = [];
  scan: for (const token of source.matchAll(tokens)) {
    const raw = token[0];
    if (raw.startsWith('//') || raw.startsWith('/*') || raw.startsWith(';')) {
      if (!marked) {
        if (commentEnd !== undefined && /\S/.test(source.slice(commentEnd, token.index))) {
          current = undefined;
          pending.length = 0;
        }
        commentEnd = token.index + raw.length;
      }
      for (const part of raw.split(/\r?\n/)) {
        if (wizardStart.test(part)) active = true;
        if (!active) continue;
        if (/<<<\s*end of configuration section\s*>>>/i.test(part)) break scan;
        const tag = /^\s*(?:\/\/|\/\*|\*|;)?\s*<([^<>]+)>\s*(.*?)\s*(?:\*\/)?$/.exec(part);
        if (!tag) continue;
        const [, annotation] = tag;
        let label = tag[2];
        let kind = annotation.replace(/\s/g, '');
        if (conditionTags.has(kind)) {
          current = undefined;
          try {
            updateCondition(conditions, kind, () => {
              evaluateCondition ??= createConditionEvaluator(source, tokens, assembly);
              return evaluateCondition(label, token.index);
            });
          } catch (error) {
            rows.push({ type: 'unsupported', label: '条件标注 <' + kind + '> 无效', help: error.message, disabled: true });
          }
          continue;
        }
        if (!marked && current) {
          if (kind === 'i') {
            const inline = /^<([^<>]+)>\s*(.*)$/.exec(label);
            const inlineKind = inline?.[1].replace(/\s/g, '') ?? '';
            if (choiceTag.test(inlineKind) || rangeTag.test(inlineKind)) {
              kind = inlineKind;
              label = inline[2];
            }
          } else if (kind.startsWith('i=')) {
            kind = kind.slice(2) + '=';
          } else if (kind === 'o' && /^说明\s*[:：]/.test(label)) {
            kind = 'i';
          }
        }
        if (kind === 'i' && current) {
          current.help = [current.help, label].filter(Boolean).join(' ');
          continue;
        }
        const choice = choiceTag.exec(kind);
        if (choice && current && parseInteger(choice[1], assembly)) {
          current.choices.push([choice[1], label]);
          continue;
        }
        const range = rangeTag.exec(kind)?.slice(1);
        if (range && current && range.every(value => value === undefined || parseInteger(value, assembly))) {
          current.range = range;
          continue;
        }
        if (kind.startsWith('#') && current) {
          current.unsupported = true;
          continue;
        }
        const option = optionTag.exec(kind);
        const disabled = conditions.at(-1)?.active === false;
        if (option) {
          const [, type, skip, low, high] = option;
          current = { type, label, skip: Number(skip), low, high, choices: [], assembly, annotationEnd: token.index + raw.length };
          if (disabled) current.disabled = true;
          rows.push(current);
          pending.push(current);
        } else {
          current = undefined;
          const type = kind === 'h' || kind === 'z' ? kind : /^\/[hez]$/.test(kind) ? 'end' : 'unsupported';
          const row = { type, label: label || kind };
          if (disabled && type !== 'end') row.disabled = true;
          rows.push(row);
        }
      }
    } else if (active && pending.length) {
      const isNumeric = /^[+-]?(?:\d|\.\d|&)/.test(raw);
      const numeric = isNumeric ? parseInteger(raw, assembly) : undefined;
      if (!marked) {
        // Without a start marker, bind only a single literal in a directly annotated macro.
        if ((!isNumeric && !raw.startsWith('"')) || !isAdjacentMacroValue(source, commentEnd, token)) continue;
        const option = pending.find(row => !row.skip && (row.type === 's' ? raw.startsWith('"') : isNumeric));
        pending.length = 0;
        if (option) pending.push(option);
      }
      for (let index = pending.length - 1; index >= 0; index--) {
        const current = pending[index];

        if (!(current.type === 's' ? raw.startsWith('"') : isNumeric)) continue;
        if (current.skip > 0) {
          current.skip--;
          continue;
        }
        Object.assign(current, { raw, offset: token.index, numeric });
        if (isNumeric && !numeric) current.unsupported = true;
        pending.splice(index, 1);
      }
    }
  }
  return marked || rows.some(row => row.raw && !row.unsupported) ? rows : [];
}

function integer(value, assembly) {
  const literal = parseInteger(value, assembly);
  if (!literal) throw Error('请输入有效的整数字面量。');
  return literal.value;
}

function field(row) {
  if (row.low === undefined || row.type === 's') return;
  const low = BigInt(row.low);
  const high = BigInt(row.high ?? row.low);
  if (high < low || high > 63n) throw Error('位域须在 0–63 位之间。');
  return { low, mask: (1n << (high - low + 1n)) - 1n };
}

function numericValue(row) {
  const value = row.numeric.value;
  const bits = field(row);
  return bits ? (value >> bits.low) & bits.mask : value;
}

function display(row) {
  if (row.type === 's') return row.raw.slice(1, -1);
  return row.low === undefined ? row.raw : formatInteger(numericValue(row), row.numeric, false);
}

function replacement(row, input) {
  if (row.disabled) throw Error('该配置项的条件不成立，当前不可修改。');
  if (row.type === 's') {
    if (!/^(?:[^"\\\x00-\x1f\x7f]|\\[^\x00-\x1f\x7f])*$/.test(input)) throw Error('字符串包含未转义的引号、反斜杠或控制字符。');
    if (row.low !== undefined && input.length > Number(row.low)) throw Error('字符串超过标注长度。');
    return '"' + input + '"';
  }
  let value = integer(input.trim(), row.assembly);
  if (row.choices.length && !row.choices.some(([choice]) => integer(choice, row.assembly) === value)) throw Error('请选择列表中的值。');
  if (row.range) {
    const [min, max, step] = row.range.map(item => item === undefined ? 1n : integer(item, row.assembly));
    if (value < min || value > max || step < 1n || (value - min) % step !== 0n) throw Error('数值超出标注范围或不符合步长。');
  }
  const bits = field(row);
  const original = row.numeric.value;
  if (bits) {
    if (value < 0n || value > bits.mask) throw Error('数值超出位域范围。');
    value = (original & ~(bits.mask << bits.low)) | (value << bits.low);
  }
  if (value === original) return row.raw;
  return formatInteger(value, row.numeric);
}

module.exports = { parse, integer, numericValue, display, replacement };
