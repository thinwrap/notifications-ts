export enum CasingEnum {
  CAMEL_CASE = 'camelCase',
  PASCAL_CASE = 'PascalCase',
  SNAKE_CASE = 'snake_case',
  KEBAB_CASE = 'kebab-case',
  CONSTANT_CASE = 'CONSTANT_CASE',
}

function splitWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1\0$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1\0$2')
    .replace(/[-_\s]+/g, '\0')
    .split('\0')
    .filter(Boolean);
}

function toCamelCase(key: string): string {
  const words = splitWords(key);
  return words
    .map((w, i) =>
      i === 0
        ? w.toLowerCase()
        : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
    )
    .join('');
}

function toPascalCase(key: string): string {
  const words = splitWords(key);
  return words
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('');
}

function toSnakeCase(key: string): string {
  return splitWords(key).map((w) => w.toLowerCase()).join('_');
}

function toKebabCase(key: string): string {
  return splitWords(key).map((w) => w.toLowerCase()).join('-');
}

function toConstantCase(key: string): string {
  return splitWords(key).map((w) => w.toUpperCase()).join('_');
}

const casingFunctions: Record<CasingEnum, (key: string) => string> = {
  [CasingEnum.CAMEL_CASE]: toCamelCase,
  [CasingEnum.PASCAL_CASE]: toPascalCase,
  [CasingEnum.SNAKE_CASE]: toSnakeCase,
  [CasingEnum.KEBAB_CASE]: toKebabCase,
  [CasingEnum.CONSTANT_CASE]: toConstantCase,
};

export function transformKeys(
  obj: Record<string, unknown>,
  casing: CasingEnum,
  options: { deep?: boolean } = {}
): Record<string, unknown> {
  // `deep` defaults to true for backward compatibility of this public helper.
  // Connectors normalizing `_passthrough.body` MUST pass `deep: false`: nested
  // objects there are data-carrying maps (e.g. SendGrid `dynamic_template_data`,
  // SparkPost `substitution_data`, Postmark `templateModel`) whose keys are the
  // consumer's data and must pass VERBATIM — recursing would silently rename
  // template variables / metadata keys.
  const { deep = true } = options;
  const transform = casingFunctions[casing];
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    const newKey = transform(key);
    if (deep && value !== null && typeof value === 'object' && !Array.isArray(value) && !(typeof Buffer !== 'undefined' && value instanceof Buffer)) {
      result[newKey] = transformKeys(value as Record<string, unknown>, casing, options);
    } else {
      result[newKey] = value;
    }
  }

  return result;
}
