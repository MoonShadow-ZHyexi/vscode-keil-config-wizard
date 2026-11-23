const { parseInteger, formatInteger } = require('./integer-literals');
const { createConditionEvaluator, updateCondition } = require('./wizard-conditions');
const { namePattern, namedValueStart, readCodeBlock, readValue, replaceCodeBlock } = require('./wizard-source');

const wizardStart = /<<<\s*Use Configuration Wizard in Context Menu >>>/i;
const optionTag = /^([oqesya])(\d*)(?:\.(\d+)(?:\.\.(\d+))?)?$/;
const choiceTag = /^([+-]?[\w$'&]+)=$/;
const rangeTag = /^([+-]?[\w'&]+)(?:-|\.\.)([+-]?[\w'&]+)(?::([+-]?[\w'&]+))?$/;
const transformTag = /^#([+\-*/])([+-]?[\w'&]+)$/;
const formatTag = /^f\.([dhob])$/;
const codeTag = /^(!?)c(\d*)$/;
const conditionTags = new Set(['if', 'elif', 'else', 'endif']);
const groupTypes = new Set(['h', 'e', 'z']);
const numberFormats = {
  d: { radix: 10, prefix: '' }, h: { radix: 16, prefix: '0x' },
  o: { radix: 8, prefix: '0o' }, b: { radix: 2, prefix: '0b' }
};
const cTokens = /\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[A-Za-z_$][\w$]*|[+-]?(?:\d|\.\d)(?:[eEpP][+-]|[\w$.'])*|[{}]/g;
const asmTokens = new RegExp(/;[^\r\n]*|[+-]?&[\da-fA-F][\w$.']*/.source + '|' + cTokens.source, 'g');

function annotations(line) {
  const first = /^\s*(?:\/\/|\/\*|\*|;)?\s*<([^<>]+)>\s*(.*?)\s*(?:\*\/)?$/.exec(line);
  if (!first) return [];
  const [, annotation, text] = first;
  const kind = annotation.replace(/\s/g, '');
  const result = [{ annotation, kind, label: text }];
  // Conditional expressions and free-form help may legitimately contain angle brackets.
  if (conditionTags.has(kind) || ['i', 'n', 'd'].includes(kind)) return result;
  let start = 0;
  for (const match of text.matchAll(/<([^<>]+)>/g)) {
    const modifier = match[1].replace(/\s/g, '');
    if (!choiceTag.test(modifier) && !rangeTag.test(modifier) && !transformTag.test(modifier) &&
        !formatTag.test(modifier) && !['i', 'd'].includes(modifier)) continue;
    result.at(-1).label = text.slice(start, match.index).trim();
    result.push({ annotation: match[1], kind: modifier, label: '' });
    start = match.index + match[0].length;
    if (modifier === 'i' || modifier === 'd') break;
  }
  result.at(-1).label = text.slice(start).trim();
  return result;
}

function parseOption(annotation, kind, label, assembly, annotationEnd) {
  // Look for the legacy, whitespace-insensitive form before checking named binding.
  let option = optionTag.exec(kind);
  let name;
  if (!option) {
    const named = /^(.*?)\s+([A-Za-z_$][\w$]*)$/.exec(annotation.trim());
    if (named) {
      option = optionTag.exec(named[1].replace(/\s/g, ''));
      if (option?.[2]) return;
      name = named[2];
    }
  }
  if (!option) return;
  const [, type, skip, low, high] = option;
  const row = { type, label, skip: Number(skip), low, high, choices: [], assembly, annotationEnd };
  if (name) row.name = name;
  if (type === 'a' && (!low || Number(low) < 1 || Number(low) > 64 || high !== undefined)) {
    row.issue = '数组标注须指定 1–64 个元素，例如 <a.4>。';
  }
  return row;
}

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

function acceptsSymbol(row) {
  return row.type === 'y' || (row.type === 'o' && Boolean(row.name));
}

function legacyBinding(row) {
  return !row.name && row.type !== 'a' && row.type !== 'y';
}

function bindOptions(source, token, pending, marked, commentEnd, assembly) {
  const raw = token[0];
  const isNumeric = /^[+-]?(?:\d|\.\d|&)/.test(raw);
  const isString = raw.startsWith('"');
  const numeric = isNumeric ? parseInteger(raw, assembly) : undefined;
  const adjacent = marked || ((isNumeric || isString) && isAdjacentMacroValue(source, commentEnd, token));

  // Named targets and compound options use a source span. Legacy options still
  // count literals so existing skip indices and shared bit fields remain valid.
  for (let index = pending.length - 1; index >= 0; index--) {
    const row = pending[index];
    if (!legacyBinding(row)) {
      if (row.name && raw !== row.name) continue;
      const start = namePattern.test(raw) ? namedValueStart(source, token.index, raw) : undefined;
      if (start === undefined) continue;
      if (!row.name && !marked) {
        const startOfLine = source.lastIndexOf('\n', token.index) + 1;
        if (commentEnd === undefined || commentEnd > startOfLine || /\S/.test(source.slice(commentEnd, startOfLine))) continue;
      }
      const value = readValue(source, start, row);
      if (!value) continue;
      if (!value.issue && row.skip > 0) {
        row.skip--;
        continue;
      }
      Object.assign(row, value);
      pending.splice(index, 1);
    } else if (marked && (row.type === 's' ? isString : isNumeric)) {
      if (row.skip > 0) {
        row.skip--;
        continue;
      }
      Object.assign(row, { raw, offset: token.index, numeric });
      if (isNumeric && !numeric) row.unsupported = true;
      pending.splice(index, 1);
    }
  }

  // Markerless legacy files still bind just one directly annotated macro.
  if (!marked && adjacent) {
    const first = pending.find(row => legacyBinding(row) && !row.skip && (row.type === 's' ? isString : isNumeric));
    if (first) {
      Object.assign(first, { raw, offset: token.index, numeric });
      if (isNumeric && !numeric) first.unsupported = true;
    }
    for (let index = pending.length - 1; index >= 0; index--) {
      if (legacyBinding(pending[index])) pending.splice(index, 1);
    }
  }
}

function appendModifier(row, kind, label) {
  if (!row) return false;
  if (kind === 'i') {
    row.help = [row.help, label].filter(Boolean).join(' ');
    return true;
  }
  if (kind === 'd' && row.choices) {
    row.defaultValue = label;
    return true;
  }
  if (!row.choices) return false;
  const choice = choiceTag.exec(kind)?.[1];
  if (choice && (parseInteger(choice, row.assembly) || (acceptsSymbol(row) && namePattern.test(choice)))) {
    row.choices.push([choice, label]);
    return true;
  }
  const range = rangeTag.exec(kind)?.slice(1);
  if (range && range.every(value => value === undefined || parseInteger(value, row.assembly))) {
    row.range = range;
    return true;
  }
  const format = formatTag.exec(kind)?.[1];
  if (format && ['o', 'y', 'a'].includes(row.type)) {
    row.format = format;
    return true;
  }
  if (kind.startsWith('#')) {
    const transform = transformTag.exec(kind);
    if (transform && ['o', 'y', 'a'].includes(row.type) && parseInteger(transform[2], row.assembly)) {
      (row.transforms ??= []).push(transform.slice(1));
    } else {
      row.issue = '数值换算标注无效。';
    }
    return true;
  }
  return false;
}

function applyGroupState(rows) {
  const stack = [];
  for (const row of rows) {
    if (row.type === 'end') {
      stack.pop();
      continue;
    }
    if (stack.at(-1)) row.disabled = true;
    if (!groupTypes.has(row.type)) continue;
    let switchedOff = false;
    if (row.type === 'e' && row.numeric) {
      try {
        switchedOff = numericValue(row) === 0n;
      } catch {
        // Invalid enable fields report their own diagnostic.
      }
    }
    stack.push(Boolean(row.disabled) || switchedOff);
  }
}

function parse(source, uri) {
  const marked = wizardStart.test(source);
  if (!marked && !/<\s*(?:[oqesya][\d.]*|!?c\d*)(?:\s+[A-Za-z_$][\w$]*)?\s*>/.test(source)) return [];
  const assembly = /\.(?:s|asm|a51|a66|inc|src|ini)$/i.test(uri?.path ?? '');
  const tokens = assembly ? asmTokens : cTokens;
  const rows = [];
  const conditions = [];
  const pending = [];
  let evaluateCondition;
  let active = !marked;
  let current;
  let commentEnd;
  let block;

  scan: for (const token of source.matchAll(tokens)) {
    const raw = token[0];
    if (!/^(?:\/\/|\/\*|;)/.test(raw)) {
      if (active && !block && pending.length) bindOptions(source, token, pending, marked, commentEnd, assembly);
      continue;
    }
    if (!marked) {
      if (commentEnd !== undefined && /\S/.test(source.slice(commentEnd, token.index))) {
        current = undefined;
        for (let index = pending.length - 1; index >= 0; index--) {
          if (!pending[index].name) pending.splice(index, 1);
        }
      }
      commentEnd = token.index + raw.length;
    }

    for (const match of raw.matchAll(/[^\r\n]*(?:\r?\n|$)/g)) {
      const part = match[0].trimEnd();
      if (wizardStart.test(part)) active = true;
      if (!active) continue;
      if (/<<<\s*end of configuration section\s*>>>/i.test(part)) break scan;
      const position = token.index + match.index;

      for (let { annotation, kind, label } of annotations(part)) {
        if (block) {
          if (codeTag.test(kind)) {
            block.depth++;
            block.row.issue = '代码块标注不可嵌套。';
          } else if (kind === '/c' && --block.depth === 0) {
            if (!block.row.issue) Object.assign(block.row, readCodeBlock(source, block.position, token.index, block.row));
            block = undefined;
            current = undefined;
          } else if (kind === 'i' || kind === 'd') {
            appendModifier(block.row, kind, label);
          }
          continue;
        }

        if (conditionTags.has(kind)) {
          current = undefined;
          try {
            updateCondition(conditions, kind, () => {
              evaluateCondition ??= createConditionEvaluator(source, tokens, assembly);
              return evaluateCondition(label, position);
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
        if (appendModifier(current, kind, label)) continue;

        const annotationEnd = token.index + raw.length;
        const code = codeTag.exec(kind);
        const option = parseOption(annotation, kind, label, assembly, annotationEnd);
        if (code) {
          current = { type: 'c', label, skip: Number(code[2]), choices: [], annotationEnd, inverse: Boolean(code[1]),
            comment: raw.startsWith(';') ? ';' : '//' };
          block = { row: current, depth: 1, position: annotationEnd };
        } else if (option) {
          current = option;
          if (!option.issue) pending.push(option);
        } else {
          const type = ['h', 'z', 'n'].includes(kind) ? kind : /^\/[hez]$/.test(kind) ? 'end' : 'unsupported';
          current = { type, label: label || kind };
        }
        if (conditions.at(-1)?.active === false && current.type !== 'end') current.disabled = true;
        rows.push(current);
      }
    }
  }
  if (block) block.row.issue ??= '代码块缺少 </c>。';
  applyGroupState(rows);
  return marked || rows.some(isEditable) ? rows : [];
}

function isEditable(row) {
  return Boolean(row.raw) && !row.unsupported && !row.issue && ['o', 'q', 'e', 's', 'y', 'a', 'c'].includes(row.type);
}

function integer(value, assembly) {
  const literal = parseInteger(value, assembly);
  if (!literal) throw Error('请输入有效的整数字面量。');
  return literal.value;
}

function field(row) {
  if (row.low === undefined || row.type === 's' || row.type === 'a') return;
  const low = BigInt(row.low);
  const high = BigInt(row.high ?? row.low);
  if (high < low || high > 63n) throw Error('位域须在 0–63 位之间。');
  return { low, mask: (1n << (high - low + 1n)) - 1n };
}

const inverses = { '+': '-', '-': '+', '*': '/', '/': '*' };

function transformValue(value, row, inverse = false) {
  const transforms = row.transforms ?? [];
  // Keil transforms input before writing it. Display applies the reverse chain.
  for (const [operator, operand] of inverse ? [...transforms].reverse() : transforms) {
    const amount = integer(operand, row.assembly);
    const operation = inverse ? inverses[operator] : operator;
    if ((operator === '*' || operator === '/') && amount === 0n) throw Error('乘除换算的因子不可为 0。');
    switch (operation) {
      case '+': value += amount; break;
      case '-': value -= amount; break;
      case '*': value *= amount; break;
      case '/':
        if (value % amount !== 0n) throw Error('换算结果必须为整数。');
        value /= amount;
        break;
    }
  }
  return value;
}

function numericValue(row) {
  if (row.type === 'c') return BigInt(row.inverse === row.commented);
  const value = row.numeric.value;
  const bits = field(row);
  return transformValue(bits ? (value >> bits.low) & bits.mask : value, row, true);
}

function formatDisplay(value, row, numeric) {
  const options = row.format ? { ...numberFormats[row.format], sign: '', suffix: '', digits: '', implicitOctal: false } : numeric;
  return formatInteger(value, options, false);
}

function display(row) {
  if (row.type === 's') return row.raw.slice(1, -1);
  if (row.type === 'a') {
    return row.elements.map(({ raw, numeric }) =>
      row.format || row.transforms ? formatDisplay(transformValue(numeric.value, row, true), row, numeric) : raw).join(', ');
  }
  if (!row.numeric || (row.low === undefined && !row.format && !row.transforms)) return row.raw;
  return formatDisplay(numericValue(row), row, row.numeric);
}

function selectedChoiceIndex(row) {
  if (!row.numeric) return row.choices.findIndex(([key]) => key === row.raw);
  const value = numericValue(row);
  return row.choices.findIndex(([key]) => parseInteger(key, row.assembly)?.value === value);
}

function validateRange(row, value) {
  if (!row.range) return;
  const [min, max, step] = row.range.map(item => item === undefined ? 1n : integer(item, row.assembly));
  if (value < min || value > max || step < 1n || (value - min) % step !== 0n) throw Error('数值超出标注范围或不符合步长。');
}

function replaceArray(row, input) {
  const values = input.trim().replace(/^\{(.*)\}$/s, '$1').replace(/,\s*$/, '').split(',');
  if (values.length !== row.elements.length) throw Error('请输入 ' + row.elements.length + ' 个数组元素。');
  let result = row.raw;
  // Replace from right to left so the original offsets stay valid.
  for (let index = values.length - 1; index >= 0; index--) {
    const { start, raw, numeric } = row.elements[index];
    const value = integer(values[index].trim(), row.assembly);
    validateRange(row, value);
    const stored = transformValue(value, row);
    if (stored === numeric.value) continue;
    const replacement = formatInteger(stored, numeric);
    result = result.slice(0, start) + replacement + result.slice(start + raw.length);
  }
  return result;
}

function defaultInput(row) {
  const value = row.defaultValue;
  if (typeof value !== 'string') throw Error('此配置项没有默认值。');
  const quoted = row.type === 's' && /^(?:u8|[LuU])?"((?:\\.|[^"\\])*)"$/.exec(value);
  return quoted ? quoted[1] : value;
}

function replacement(row, input) {
  if (row.disabled) throw Error('该配置项的条件不成立，当前不可修改。');
  if (row.type === 's') {
    if (!/^(?:[^"\\\x00-\x1f\x7f]|\\[^\x00-\x1f\x7f])*$/.test(input)) throw Error('字符串包含未转义的引号、反斜杠或控制字符。');
    if (row.low !== undefined && input.length > Number(row.low)) throw Error('字符串超过标注长度。');
    return '"' + input + '"';
  }
  const text = input.trim();
  if (row.type === 'c') {
    if (!/^[01]$/.test(text)) throw Error('开关值无效。');
    return replaceCodeBlock(row, text);
  }
  if (row.type === 'a') return replaceArray(row, text);
  const inputInteger = parseInteger(text, row.assembly);
  if (row.choices.length && !row.choices.some(([choice]) =>
    inputInteger ? parseInteger(choice, row.assembly)?.value === inputInteger.value : choice === text)) {
    throw Error('请选择列表中的值。');
  }
  if (!inputInteger && acceptsSymbol(row) && namePattern.test(text) && !row.transforms && !field(row)) return text;
  if (!inputInteger) throw Error('请输入有效的整数字面量。');

  validateRange(row, inputInteger.value);
  let value = transformValue(inputInteger.value, row);
  const bits = field(row);
  const original = row.numeric?.value;
  if (bits) {
    if (original === undefined) throw Error('位域只能用于整数。');
    if (value < 0n || value > bits.mask) throw Error('数值超出位域范围。');
    value = (original & ~(bits.mask << bits.low)) | (value << bits.low);
  }
  if (value === original) return row.raw;
  return formatInteger(value, row.numeric ?? inputInteger);
}

function createDocumentReader() {
  const eligibility = new WeakMap();
  let recent;

  function read(document) {
    const { version } = document;
    if (recent?.document === document && Number.isInteger(version) && recent.version === version) return recent;

    const text = document.getText();
    if (recent?.document !== document || recent.text !== text) {
      const rows = parse(text, document.uri);
      recent = { document, version, text, rows, eligible: rows.some(isEditable) };
    } else {
      recent.version = version;
    }
    // Keep one parsed document for the toolbar and wizard to share. Other tabs
    // only need their last eligibility result, rather than a copy of their text.
    eligibility.set(document, { version, eligible: recent.eligible });
    return recent;
  }

  function isEligible(document) {
    const cached = eligibility.get(document);
    return cached && Number.isInteger(document.version) && cached.version === document.version
      ? cached.eligible
      : read(document).eligible;
  }

  return { read, isEligible };
}

module.exports = { parse, integer, numericValue, display, replacement, defaultInput, isEditable, selectedChoiceIndex, createDocumentReader };
