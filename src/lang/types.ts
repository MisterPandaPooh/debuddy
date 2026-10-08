import * as vscode from 'vscode';

/** A call made by a statement, with the position of the callee identifier (for the LSP). */
export interface CallSite {
  name: string;
  position: vscode.Position;
}

/** One "step": a statement the user can stop on. Lines are 1-based. */
export interface Step {
  line: number;
  endLine: number;
  text: string;
  /** Project calls made by this statement, with the callee identifier position. */
  calls: CallSite[];
  /** Variables this statement declares (incl. destructuring), for example values. */
  declared: { name: string; position: vscode.Position }[];
  /** For `if` heads: the line ranges of each branch body, so the user can pick a path. */
  branches?: Branch[];
  /** The `catch` step that would receive an exception thrown here, if the step is inside a `try`. */
  handler?: { line: number; text: string };
  /** For `throw` statements: the error being thrown. Certain, so stepping follows it. */
  throwsSelf?: string;
  /** A `throw` nested in a one-line statement (`if (x) throw …`). Possible, not certain. */
  mayThrow?: string;
}

export interface Branch {
  label: string;
  from: number;
  to: number;
}

/** A function the user is stepping through. */
export interface Frame {
  uri: vscode.Uri;
  name: string;
  /** Signature + body, as shown to the model. */
  source: string;
  startLine: number;
  steps: Step[];
  index: number;
  /** Why we stepped into this frame (empty for the entry frame). */
  reason: string;
  /** Error classes thrown directly in this function body (not in nested functions). */
  throws: string[];
  /** Position of the function name, for reference lookups; absent for anonymous functions. */
  namePosition?: vscode.Position;
  /** Line ranges the user chose not to explore (the other side of an `if`). */
  skip: Branch[];
}

/** What a language has to provide: turn a position into a walkable function. */
export interface LanguageSupport {
  /** VS Code language ids this implementation handles. */
  readonly languages: string[];
  /** Build the frame for the function containing `line` (1-based); `undefined` if none. */
  frameAt(doc: vscode.TextDocument, line: number, reason?: string): Frame | undefined;
}
