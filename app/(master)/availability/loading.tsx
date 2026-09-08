export default function Loading() {
  return (
    <div className="space-y-5" aria-busy="true">
      <div className="h-6 w-32 animate-pulse rounded bg-slate-200" />
      <div className="h-40 animate-pulse rounded-2xl bg-slate-200" />
      <div className="h-24 animate-pulse rounded-2xl bg-slate-100" />
    </div>
  );
}
