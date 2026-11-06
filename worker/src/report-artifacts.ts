export function reportObjectKeys(reportId: string) {
  const prefix = `pediatric-oral-boards/reports/${reportId}`;

  return {
    json: `${prefix}.json`,
    markdown: `${prefix}.md`,
    cheatsheet: `${prefix}-cheatsheet.md`,
  };
}
