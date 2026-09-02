import React from "react";
import { fmtDate } from "./labels";

/**
 * Import home-time rows from screenshots of an external tracker.
 *
 * Read and apply are two buttons because they are two decisions: the read is a
 * proposal an admin checks row by row, and unmatched rows arrive unticked so a
 * driver the reader could not identify is never written against the wrong
 * group.
 *
 * Split out of admin/src/pages/HomeTimePage.jsx.
 */
export function ScreenshotImportCard({
  importFiles, setImportFiles, importRows, setImportRows,
  importing, applyingImport, readScreenshots, applyImport,
}) {
  return (
    <>

  <div className="card" style={{ marginBottom: 20 }}>
    <h3>Import from screenshots</h3>
    <p className="home-time-muted" style={{ marginTop: 0 }}>
      Upload spreadsheet screenshots. The app reads current status, dates, and history, then lets you review the matched rows before applying them.
    </p>
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
      <input
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        onChange={(e) => setImportFiles(Array.from(e.target.files || []))}
      />
      <button className="btn btn-primary" onClick={readScreenshots} disabled={importing || !importFiles.length}>
        {importing ? "Reading..." : "Read screenshots"}
      </button>
    </div>

    {importRows && (
      <div style={{ marginTop: 16 }}>
        <div className="table-container">
          <table className="table">
            <thead>
              <tr>
                <th>Use</th>
                <th>Name from image</th>
                <th>Matched driver</th>
                <th>Status</th>
                <th>Since</th>
                <th>History</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {importRows.map((row, index) => (
                <tr
                  key={index}
                  style={!row.matched ? { background: "rgba(239, 68, 68, 0.08)" } : undefined}
                >
                  <td>
                    <input
                      type="checkbox"
                      checked={row._include && row.matched}
                      disabled={!row.matched}
                      onChange={(e) => {
                        const next = [...importRows];
                        next[index] = { ...next[index], _include: e.target.checked };
                        setImportRows(next);
                      }}
                    />
                  </td>
                  <td>{row.name}</td>
                  <td>{row.matched ? row.driver_label : <span style={{ color: "#ef4444" }}>No match</span>}</td>
                  <td>{row.status === "road" ? "On the road" : row.status === "home" ? "At home" : "--"}</td>
                  <td>{row.since_date || "--"}</td>
                  <td>{row.history?.length ? `${row.history.length} period(s)` : "--"}</td>
                  <td style={{ maxWidth: 220, whiteSpace: "normal" }}>{row.notes || "--"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button className="btn btn-primary" onClick={applyImport} disabled={applyingImport} style={{ marginTop: 8 }}>
          {applyingImport
            ? "Applying..."
            : `Apply ${importRows.filter((row) => row._include && row.group_id).length} matched rows`}
        </button>
      </div>
    )}
  </div>

  {unlinkedActivity.length > 0 && (
    <div className="card">
      <h3>Unlinked activity</h3>
      <p className="home-time-muted" style={{ marginTop: 0 }}>
        These requests or completed trips do not point to a currently tracked driver status, so they stay visible here instead of disappearing.
      </p>
      <div className="table-container">
        <table className="table">
          <thead>
            <tr>
              <th>Type</th>
              <th>Driver</th>
              <th>Date</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {unlinkedActivity.map((item) => (
              <tr key={item.id}>
                <td>{item.kind === "request" ? "Request" : "Trip"}</td>
                <td>
                  <div className="home-time-driver-name">{item.driver_name}</div>
                  <div className="home-time-subtext">
                    {driverTypeLabel(item.driver_type)}
                    {item.unit_number ? ` | Unit ${item.unit_number}` : ""}
                  </div>
                </td>
                <td>{fmtDate(item.timestamp)}</td>
                <td>
                  {item.kind === "request"
                    ? `${requestStatusMeta(item.status, item.clarification_channel).label} | ${fmtDate(item.home_from)} to ${fmtDate(item.home_to)} | ${item.source || "--"}`
                    : `${fmtDate(item.road_started_at)} to ${fmtDate(item.home_arrived_at)} | ${money(item.bonus_usd)}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )}
    </>
  );
}
