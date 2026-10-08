/**
 * Per-language surface syntax for the LSP-generic walker: enough to name branches, spot
 * raises/declarations and skip comments. Everything structural comes from the language server.
 */
export interface KeywordProfile {
  languages: string[];
  /** Blocks are delimited by indentation (python) rather than braces. */
  indentBased?: boolean;
  comment: RegExp;
  /** Statement heads that open a branch, with the label used in the branch picker. */
  branch: { re: RegExp; label: string }[];
  /** `try` opener and the handler head (`except`, `catch`, `rescue`). */
  try?: { open: RegExp; handler: RegExp; finally?: RegExp };
  /** Certain raise: returns the error name. */
  throws: { re: RegExp; name: (m: RegExpMatchArray) => string }[];
  /** Possible raise (e.g. rust `?`). */
  mayThrow?: { re: RegExp; name: string }[];
  /** Variable declarations: capture group 1 is the name. */
  decl: RegExp[];
  /** Keywords that look like calls but are not (`if (`, `while (`…). */
  notCalls: Set<string>;
}

const C_LIKE_CALL_NOISE = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'throw', 'sizeof', 'typeof', 'match', 'elseif', 'foreach', 'await', 'yield']);

const cLike = (languages: string[], extra: Partial<KeywordProfile> = {}): KeywordProfile => ({
  languages,
  comment: /^\s*(\/\/|\/\*|\*)/,
  branch: [
    { re: /^\s*if\b/, label: 'if' },
    { re: /^\s*}?\s*else\s+if\b/, label: 'else if' },
    { re: /^\s*}?\s*else\b/, label: 'else' },
    { re: /^\s*switch\b/, label: 'switch' },
    { re: /^\s*case\b|^\s*default\s*:/, label: 'case' },
  ],
  try: { open: /^\s*try\b/, handler: /^\s*}?\s*catch\b/, finally: /^\s*}?\s*finally\b/ },
  throws: [{ re: /\bthrow\s+(?:new\s+)?([A-Za-z_][\w.]*)/, name: (m) => m[1].split('.').pop()! }],
  decl: [/\b(?:var|let|const|val|final)\s+([A-Za-z_]\w*)\s*[:=]/, /^\s*(?:[A-Z][\w<>,?\[\] ]*|int|long|double|float|bool|boolean|string|char|auto)\s+([A-Za-z_]\w*)\s*=/],
  notCalls: C_LIKE_CALL_NOISE,
  ...extra,
});

export const keywordProfiles: KeywordProfile[] = [
  {
    languages: ['python'],
    indentBased: true,
    comment: /^\s*#/,
    branch: [
      { re: /^\s*if\b/, label: 'if' },
      { re: /^\s*elif\b/, label: 'elif' },
      { re: /^\s*else\s*:/, label: 'else' },
      { re: /^\s*match\b/, label: 'match' },
      { re: /^\s*case\b/, label: 'case' },
    ],
    try: { open: /^\s*try\s*:/, handler: /^\s*except\b/, finally: /^\s*finally\s*:/ },
    throws: [{ re: /\braise\s+([A-Za-z_][\w.]*)/, name: (m) => m[1].split('.').pop()! }],
    decl: [/^\s*([A-Za-z_]\w*)\s*(?::[^=]+)?=[^=]/, /\bas\s+([A-Za-z_]\w*)\s*:/, /^\s*for\s+([A-Za-z_]\w*)\s+in\b/],
    notCalls: new Set(['if', 'elif', 'while', 'for', 'print', 'return', 'not', 'and', 'or', 'in', 'lambda', 'await', 'yield']),
  },
  {
    languages: ['rust'],
    comment: /^\s*(\/\/|\/\*|\*)/,
    branch: [
      { re: /^\s*(?:}\s*)?if\b/, label: 'if' },
      { re: /^\s*}\s*else\s+if\b/, label: 'else if' },
      { re: /^\s*}\s*else\b/, label: 'else' },
      { re: /^\s*match\b/, label: 'match' },
      { re: /^\s*[\w:(),_ ]+=>\s*/, label: 'arm' },
    ],
    throws: [{ re: /\b(panic|unreachable|todo|unimplemented)!/, name: (m) => `${m[1]}!` }, { re: /\breturn\s+Err\(/, name: () => 'Err' }],
    mayThrow: [{ re: /\?[;\s).]/, name: '? (Err propagates to the caller)' }, { re: /\.(unwrap|expect)\(/, name: 'panic on Err/None' }],
    decl: [/\blet\s+(?:mut\s+)?([A-Za-z_]\w*)/],
    notCalls: new Set(['if', 'while', 'for', 'match', 'return', 'Some', 'Ok', 'Err', 'None', 'await', 'loop']),
  },
  {
    languages: ['go'],
    comment: /^\s*(\/\/|\/\*|\*)/,
    branch: [
      { re: /^\s*(?:}\s*)?if\b/, label: 'if' },
      { re: /^\s*}\s*else\s+if\b/, label: 'else if' },
      { re: /^\s*}\s*else\b/, label: 'else' },
      { re: /^\s*switch\b|^\s*select\b/, label: 'switch' },
      { re: /^\s*case\b|^\s*default\s*:/, label: 'case' },
    ],
    throws: [{ re: /\bpanic\(/, name: () => 'panic' }],
    mayThrow: [{ re: /\breturn\b.*\berr\b/, name: 'err returned to the caller' }],
    decl: [/\b([A-Za-z_]\w*)\s*:=/, /\bvar\s+([A-Za-z_]\w*)\b/],
    notCalls: new Set(['if', 'for', 'switch', 'return', 'defer', 'go', 'func', 'select', 'case', 'make', 'append', 'len']),
  },
  cLike(['java', 'kotlin', 'scala', 'csharp', 'cpp', 'c', 'objective-c', 'dart', 'swift']),
  cLike(['php'], { decl: [/(\$[A-Za-z_]\w*)\s*=/] }),
  {
    languages: ['ruby'],
    comment: /^\s*#/,
    branch: [
      { re: /^\s*if\b|^\s*unless\b/, label: 'if' },
      { re: /^\s*elsif\b/, label: 'elsif' },
      { re: /^\s*else\b/, label: 'else' },
      { re: /^\s*case\b/, label: 'case' },
      { re: /^\s*when\b/, label: 'when' },
    ],
    try: { open: /^\s*begin\b/, handler: /^\s*rescue\b/, finally: /^\s*ensure\b/ },
    throws: [{ re: /\braise\s+([A-Za-z_][\w:]*)/, name: (m) => m[1].split('::').pop()! }],
    decl: [/^\s*([a-z_]\w*)\s*=[^=]/],
    notCalls: new Set(['if', 'unless', 'while', 'until', 'puts', 'return', 'yield', 'raise', 'require']),
  },
];

export const defaultKeywordProfile: KeywordProfile = cLike(['*']);
