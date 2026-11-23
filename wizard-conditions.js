const { parseInteger } = require('./integer-literals');

const identifier = /^[A-Za-z_$][\w$]*$/;
const unary = new Map([
  ['+', value => value], ['-', value => -value], ['~', value => ~value], ['!', value => BigInt(value === 0n)]
]);
const binary = new Map([
  ['||', [1, (a, b) => BigInt(a !== 0n || b !== 0n)]],
  ['&&', [2, (a, b) => BigInt(a !== 0n && b !== 0n)]],
  ['|', [3, (a, b) => a | b]],
  ['^', [4, (a, b) => a ^ b]],
  ['&', [5, (a, b) => a & b]],
  ['==', [6, (a, b) => BigInt(a === b)]],
  ['!=', [6, (a, b) => BigInt(a !== b)]],
  ['<', [7, (a, b) => BigInt(a < b)]],
  ['<=', [7, (a, b) => BigInt(a <= b)]],
  ['>', [7, (a, b) => BigInt(a > b)]],
  ['>=', [7, (a, b) => BigInt(a >= b)]],
  ['<<', [8, (a, b) => a << shiftCount(b)]],
  ['>>', [8, (a, b) => a >> shiftCount(b)]],
  ['+', [9, (a, b) => a + b]],
  ['-', [9, (a, b) => a - b]],
  ['*', [10, (a, b) => a * b]],
  ['/', [10, (a, b) => a / b]],
  ['%', [10, (a, b) => a % b]]
]);

function shiftCount(value) {
  if (value < 0n || value > 63n) throw Error('移位数量须在 0–63 之间。');
  return value;
}

function tokenize(expression) {
  const tokens = /\s+|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|[A-Za-z_$][\w$]*|\d[\w']*|'(?:\\.|[^'\\\r\n])*'|&&|\|\||<<|>>|<=|>=|==|!=|[()+\-*/%&|^~!<>?:]/y;
  const result = [];
  while (tokens.lastIndex < expression.length) {
    const offset = tokens.lastIndex;
    const token = tokens.exec(expression)?.[0];
    if (!token) throw Error('无法识别的表达式符号：' + expression[offset]);
    if (!/^\s|^\/[/\*]/.test(token)) result.push(token);
  }
  return result;
}

function expand(expression, macros) {
  const expanded = [];
  const expanding = new Set();
  let visited = 0;

  function append(tokens) {
    for (let index = 0; index < tokens.length; index++) {
      if (++visited > 4096 || expanding.size >= 64) throw Error('条件表达式展开过长。');
      const token = tokens[index];
      if (token === 'defined') {
        const parenthesized = tokens[index + 1] === '(';
        if (parenthesized) index++;
        const name = tokens[++index];
        if (!identifier.test(name ?? '') || (parenthesized && tokens[++index] !== ')')) {
          throw Error('defined 后需要宏名称。');
        }
        expanded.push(macros.has(name) ? '1' : '0');
        continue;
      }
      const macro = macros.get(token);
      if (typeof macro === 'string' && !expanding.has(token)) {
        expanding.add(token);
        append(tokenize(macro));
        expanding.delete(token);
      } else {
        expanded.push(token);
      }
    }
  }

  append(tokenize(expression));
  return expanded;
}

function characterValue(token) {
  const content = token.slice(1, -1);
  if ([...content].length === 1) return BigInt(content.codePointAt(0));
  const escapes = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92, "'": 39, '"': 34, '?': 63 };
  if (/^\\x[\da-f]+$/i.test(content)) return BigInt('0x' + content.slice(2));
  if (/^\\[0-7]{1,3}$/.test(content)) return BigInt('0o' + content.slice(1));
  if (content.length === 2 && content[0] === '\\' && Object.hasOwn(escapes, content[1])) return BigInt(escapes[content[1]]);
  throw Error('条件只支持单字符常量。');
}

function evaluateExpression(expression, macros, assembly) {
  const tokens = expand(expression, macros);
  let cursor = 0;
  const take = token => {
    if (tokens[cursor] !== token) return false;
    cursor++;
    return true;
  };
  const expect = token => {
    if (!take(token)) throw Error('表达式缺少 ' + token + '。');
  };

  function operand(evaluate) {
    if (take('(')) {
      const value = conditional(evaluate);
      expect(')');
      return value;
    }
    const token = tokens[cursor++];
    if (unary.has(token)) {
      const value = operand(evaluate);
      return evaluate ? unary.get(token)(value) : 0n;
    }
    if (token?.startsWith("'")) return characterValue(token);
    if (token === 'true') return 1n;
    if (identifier.test(token ?? '')) return 0n;
    const number = token && parseInteger(token, assembly);
    if (number) return number.value;
    throw Error('表达式需要整数、宏名称或括号。');
  }

  function infix(minimum, evaluate) {
    let value = operand(evaluate);
    while (true) {
      const operator = tokens[cursor];
      const operation = binary.get(operator);
      if (!operation || operation[0] < minimum) return value;
      cursor++;
      const evaluateRight = evaluate && (operator !== '&&' || value !== 0n) && (operator !== '||' || value === 0n);
      const right = infix(operation[0] + 1, evaluateRight);
      if (evaluate) value = operation[1](value, evaluateRight ? right : 0n);
    }
  }

  function conditional(evaluate) {
    const condition = infix(1, evaluate);
    if (!take('?')) return condition;
    const yes = conditional(evaluate && condition !== 0n);
    expect(':');
    const no = conditional(evaluate && condition === 0n);
    return condition !== 0n ? yes : no;
  }

  const value = conditional(true);
  if (cursor !== tokens.length) throw Error('表达式末尾有多余内容。');
  return value !== 0n;
}

function updateCondition(stack, kind, test) {
  if (kind === 'if') {
    stack.push({ parent: stack.at(-1)?.active ?? true, active: false, matched: false, elseSeen: false });
  }
  const branch = stack.at(-1);
  if (!branch) throw Error('缺少对应的 <if>。');
  if (kind === 'endif') {
    stack.pop();
    return;
  }
  if (branch.elseSeen) {
    branch.active = false;
    throw Error('<else> 后只能使用 <endif>。');
  }
  branch.elseSeen = kind === 'else';
  branch.active = false;
  if (!branch.parent || branch.matched) return;
  try {
    branch.active = kind === 'else' || test();
    branch.matched = branch.active;
  } catch (error) {
    // An invalid test cannot safely select any alternative in this group.
    branch.matched = true;
    throw error;
  }
}

function createConditionEvaluator(source, sourceTokens, assembly) {
  const code = source.replace(sourceTokens, token =>
    /^(?:\/[/\*]|;)/.test(token) ? token.replace(/[^\r\n]/g, ' ') : token);
  const directives = code.matchAll(/^[\t ]*#[\t ]*(define|undef|if|ifdef|ifndef|elif|else|endif)\b((?:\\\r?\n|[^\r\n])*)/gm);
  const macros = new Map();
  const branches = [];
  let next = directives.next();

  return (expression, position) => {
    while (!next.done && next.value.index < position) {
      const [, directive, argument] = next.value;
      next = directives.next();
      const value = argument.replace(/\\\r?\n/g, '').trim();
      if (directive === 'define' || directive === 'undef') {
        if (branches.at(-1)?.active === false) continue;
        const match = /^([A-Za-z_$][\w$]*)(.*)$/.exec(value);
        if (!match) continue;
        const [, name, body] = match;
        if (directive === 'undef') macros.delete(name);
        else macros.set(name, body.startsWith('(') ? null : body.trim());
        continue;
      }
      const kind = directive === 'ifdef' || directive === 'ifndef' ? 'if' : directive;
      try {
        updateCondition(branches, kind, () => {
          if (directive === 'ifdef') return macros.has(value);
          if (directive === 'ifndef') return !macros.has(value);
          return evaluateExpression(value, macros, assembly);
        });
      } catch {
        // Compiler-specific directives may be undecidable using just this file.
      }
    }
    return evaluateExpression(expression, macros, assembly);
  };
}

module.exports = { createConditionEvaluator, updateCondition };
