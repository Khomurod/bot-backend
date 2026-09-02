import { useState } from "react";
import * as api from "../../api";

/**
 * Import driver home-time rows from screenshots of an external tracker.
 *
 * READ AND APPLY ARE SEPARATE STEPS on purpose: AI vision reads the
 * screenshots and returns matched rows for review, and only the apply step
 * writes. Unmatched rows default to EXCLUDED (`_include: row.matched`), so a
 * driver the reader could not tie to a group is never silently written against
 * the wrong one — an admin has to tick it deliberately.
 *
 * A successful apply reloads the overview, because the write changes both
 * current state and trip history.
 *
 * Split out of admin/src/pages/HomeTimePage.jsx.
 */
export function useHomeTimeImport(flash, setStatus, reload) {
  const [importFiles, setImportFiles] = useState([]);
  const [importRows, setImportRows] = useState(null);
  const [importing, setImporting] = useState(false);
  const [applyingImport, setApplyingImport] = useState(false);

  const readScreenshots = async () => {
    if (!importFiles.length) {
      flash("error", "Choose one or more screenshots first.");
      return;
    }
    setImporting(true);
    setStatus(null);
    setImportRows(null);
    try {
      const res = await api.importHomeTimeScreenshots(importFiles);
      const rows = (res.rows || []).map((row) => ({ ...row, _include: row.matched }));
      setImportRows(rows);
      flash(
        "success",
        `Read ${res.total} drivers - ${res.matched} matched to groups, ${res.unmatched} unmatched.`
      );
    } catch (err) {
      flash("error", err.message);
    } finally {
      setImporting(false);
    }
  };

  const applyImport = async () => {
    const rows = (importRows || []).filter((row) => row._include && row.group_id);
    if (!rows.length) {
      flash("error", "No matched rows are selected to apply.");
      return;
    }
    setApplyingImport(true);
    setStatus(null);
    try {
      const report = await api.applyHomeTimeImport(rows);
      flash(
        "success",
        `Applied: ${report.statusesUpdated} statuses set, ${report.historyAdded} home-times added${
          report.historySkipped ? `, ${report.historySkipped} duplicates skipped` : ""
        }.`
      );
      setImportRows(null);
      setImportFiles([]);
      await reload();
    } catch (err) {
      flash("error", err.message);
    } finally {
      setApplyingImport(false);
    }
  };

  return {
    importFiles, setImportFiles, importRows, setImportRows,
    importing, applyingImport, readScreenshots, applyImport,
  };
}
