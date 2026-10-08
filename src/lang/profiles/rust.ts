import type { Node } from 'web-tree-sitter';
import { TreeSitterProfile } from '../treesitter';

const PANICS = new Set(['panic', 'unreachable', 'todo', 'unimplemented']);

/** `panic!(...)` and friends: certain, never caught. */
function panicName(n: Node): string | undefined {
  const name = n.childForFieldName('macro')?.text.split('::').pop();
  return name && PANICS.has(name) ? `${name}!` : undefined;
}

/** `return Err(...)` / tail `Err(...)`: the function hands an error to its caller. */
function errReturn(n: Node): string | undefined {
  const inner = n.type === 'return_expression' ? n.namedChildren[0] : n;
  if (inner?.type === 'call_expression' && inner.childForFieldName('function')?.text === 'Err') return 'Err';
  return undefined;
}

export const rustProfile: TreeSitterProfile = {
  languages: ['rust'],
  grammar: 'tree-sitter-rust.wasm',
  functionTypes: ['function_item', 'function_signature_item'],
  nestedTypes: ['function_item', 'closure_expression', 'impl_item', 'trait_item', 'mod_item'],
  blockTypes: ['block', 'match_block'],
  unwrapTypes: ['expression_statement'],
  compound: {
    if_expression: { head: 'condition', bodies: ['consequence'], clauses: ['else_clause'], branching: true },
    else_clause: { bodies: ['block', 'if_expression'] },
    match_expression: { head: 'value', bodies: [], clauses: ['match_arm'], branching: true },
    match_arm: { bodies: ['value'] },
    for_expression: { bodies: ['body'] },
    while_expression: { head: 'condition', bodies: ['body'] },
    loop_expression: { bodies: ['body'] },
    unsafe_block: { bodies: ['block'] },
  },
  callTypes: { call_expression: 'function', macro_invocation: 'macro', method_call_expression: 'name' },
  declTypes: { let_declaration: 'pattern', let_condition: 'pattern' },
  throwTypes: { macro_invocation: panicName, return_expression: errReturn },
  // `?` hands any Err to the caller: possible, not certain.
  mayThrowTypes: { try_expression: () => '? (Err propagates to the caller)', call_expression: errReturn },
};
