export default function ReportsLoading() {
  return (
    <main className="report-library-gate">
      <div className="report-library-loading" role="status">
        <span className="loading-cat" aria-hidden="true">AC</span>
        <p>Loading completed reports…</p>
      </div>
    </main>
  );
}
