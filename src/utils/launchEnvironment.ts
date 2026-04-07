export function parseLaunchEnvironment(input: string): Record<string, string> {
  const environment: Record<string, string> = {};
  let index = 0;

  while (index < input.length) {
    index = skipWhitespace(input, index);
    if (index >= input.length) {
      break;
    }

    const keyStart = index;
    while (index < input.length && /[A-Za-z0-9_]/.test(input[index])) {
      index++;
    }

    const key = input.slice(keyStart, index);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`無効な環境変数名です: ${input.slice(keyStart).split(/\s/, 1)[0]}`);
    }

    if (input[index] !== '=') {
      throw new Error(`${key} の値は KEY=value 形式で指定してください`);
    }
    index++;

    const parsed = readValue(input, index);
    environment[key] = parsed.value;
    index = parsed.nextIndex;
  }

  return environment;
}

function skipWhitespace(input: string, index: number): number {
  while (index < input.length && /\s/.test(input[index])) {
    index++;
  }
  return index;
}

function readValue(input: string, index: number): { value: string; nextIndex: number } {
  if (index >= input.length || /\s/.test(input[index])) {
    return { value: '', nextIndex: index };
  }

  if (input[index] === '"' || input[index] === "'") {
    return readQuotedValue(input, index);
  }

  const start = index;
  while (index < input.length && !/\s/.test(input[index])) {
    index++;
  }

  return { value: input.slice(start, index), nextIndex: index };
}

function readQuotedValue(input: string, index: number): { value: string; nextIndex: number } {
  const quote = input[index];
  index++;
  let value = '';

  while (index < input.length) {
    const current = input[index];
    if (current === quote) {
      return { value, nextIndex: index + 1 };
    }

    if (quote === '"' && current === '\\') {
      index++;
      if (index >= input.length) {
        throw new Error('ダブルクォート文字列の末尾でエスケープが切れています');
      }

      const escaped = input[index];
      value += escaped === 'n' ? '\n'
        : escaped === 'r' ? '\r'
          : escaped === 't' ? '\t'
            : escaped;
      index++;
      continue;
    }

    value += current;
    index++;
  }

  throw new Error('クォート文字列が閉じられていません');
}