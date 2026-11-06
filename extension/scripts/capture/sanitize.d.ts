export interface SanitizerRedactions {
  emails: number;
  phones: number;
  sensitiveValues: number;
  names: number;
  employers: number;
  files: number;
  personNames: number;
  handles: number;
  images: number;
  hiddenInputs: number;
  scripts: number;
  styles: number;
  meta: number;
  elements: number;
  dataAttributes: number;
  formValues: number;
  comments: number;
}

export interface SanitizerOptions {
  readonly userNames?: readonly string[];
  readonly employerNames?: readonly string[];
  readonly anonymizeEmployers?: boolean;
  readonly studentPlaceholder?: string;
  readonly parseHtml?: (html: string) => Document;
  readonly maxLength?: number;
}

export interface Sanitizer {
  text(value: string): string;
  url(value: string): string;
  resourceUrl(value: string): string;
  html(value: string): string;
  readonly redactions: SanitizerRedactions;
  readonly warnings: string[];
  readonly studentPlaceholder: string;
}

export interface ResidualFinding {
  readonly kind: 'email' | 'phone' | 'token';
  readonly sample: string;
}

export const SANITIZER_VERSION: number;

export const REDACTED: {
  readonly student: string;
  readonly person: string;
  readonly email: string;
  readonly phone: string;
  readonly token: string;
  readonly handle: string;
  readonly image: string;
  readonly resultsPerPage: number;
};

export function classifyPageType(
  pathnameOrUrl: string,
  signals?: Readonly<Record<string, unknown>>,
): string;

export function sanitizeUrl(rawUrl: string, options?: { readonly resource?: boolean }): string;

export function sanitizeResourceUrl(rawUrl: string): string;

export function findResidualPii(text: string): ResidualFinding[];

export function createSanitizer(options?: SanitizerOptions): Sanitizer;

export function sanitizeHtml(rawHtml: string, options?: SanitizerOptions): string;
