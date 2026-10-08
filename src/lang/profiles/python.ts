import type { Node } from 'web-tree-sitter';
import { TreeSitterProfile } from '../treesitter';

/** Name raised by `raise X(...)`, `raise X`, `raise x.Y(...)`; bare `raise` re-raises. */
function raised(n: Node): string {
  const e = n.namedChildren[0];
  if (!e) return 'error';
  const target = e.type === 'call' ? e.childForFieldName('function') : e;
  return target?.text.split('.').pop() ?? 'error';
}

export const pythonProfile: TreeSitterProfile = {
  languages: ['python'],
  grammar: 'tree-sitter-python.wasm',
  functionTypes: ['function_definition'],
  nestedTypes: ['function_definition', 'lambda', 'class_definition'],
  blockTypes: ['block'],
  unwrapTypes: [],
  compound: {
    if_statement: { head: 'condition', bodies: ['consequence'], clauses: ['elif_clause', 'else_clause'], branching: true },
    elif_clause: { head: 'condition', bodies: ['consequence'] },
    for_statement: { bodies: ['body'], clauses: ['else_clause'] },
    while_statement: { head: 'condition', bodies: ['body'], clauses: ['else_clause'] },
    with_statement: { bodies: ['body'] },
    match_statement: { head: 'subject', bodies: [], clauses: ['case_clause'], branching: true },
    case_clause: { bodies: ['consequence'] },
  },
  callTypes: { call: 'function' },
  declTypes: { assignment: 'left', augmented_assignment: 'left', for_statement: 'left', as_pattern: 'alias', named_expression: 'name' },
  throwTypes: { raise_statement: raised },
  tryType: { type: 'try_statement', body: 'body', handler: 'except_clause', finally: 'finally_clause' },
};
