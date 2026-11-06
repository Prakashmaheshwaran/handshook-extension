export type PageType = 'search' | 'job' | 'documents' | 'my_jobs' | 'login' | 'unknown';

export interface RouteChange {
  url: string;
  page: PageType;
}

export function detectPageType(pathname: string): PageType {
  const path = pathname.toLowerCase();
  if (/\/login|\/signin|\/sso/.test(path)) return 'login';
  if (/\/job-search|\/postings|\/jobs\/?$/.test(path)) return 'search';
  if (/\/jobs\/\d+|\/stu\/jobs\/\d+/.test(path)) return 'job';
  if (/\/documents|\/profile\/documents|\/stu\/documents|^\/docs(?:\/|$)/.test(path))
    return 'documents';
  if (/\/my-jobs|\/applications/.test(path)) return 'my_jobs';
  return 'unknown';
}

export function watchRoute(onChange: (change: RouteChange) => void): () => void {
  let lastUrl = location.href;
  let timer: number | undefined;

  const emit = (force = false) => {
    if (!force && location.href === lastUrl) return;
    lastUrl = location.href;
    if (timer !== undefined) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      onChange({ url: location.href, page: detectPageType(location.pathname) });
    }, 150);
  };

  const interval = window.setInterval(() => emit(false), 500);
  const onPopState = () => emit(true);
  window.addEventListener('popstate', onPopState);
  emit(true);

  return () => {
    window.clearInterval(interval);
    window.removeEventListener('popstate', onPopState);
    if (timer !== undefined) window.clearTimeout(timer);
  };
}
