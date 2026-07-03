import React, { useState, useEffect } from 'react';
import { useApp } from '../store.jsx';
import { qs } from '../api';
import { useApi, Card, Modal, Segmented, StatusTag, Skeleton, EmptyState, ErrorState, Pagination } from '../components.jsx';

export default function EquipmentPage() {
  const { toast } = useApp();
  const [type, setType] = useState('truck');
  const [search, setSearch] = useState('');
  const [dq, setDq] = useState('');
  const [page, setPage] = useState(1);
  const [importing, setImporting] = useState(false);

  useEffect(() => { const t = setTimeout(() => { setDq(search); setPage(1); }, 300); return () => clearTimeout(t); }, [search]);

  const q = useApi(`/equipments${qs({ type, search: dq, page, pageSize: 20 })}`, [type, dq, page]);
  const rows = (q.data && q.data.data) || [];

  const refresh = () => { q.reload(); toast('Refreshed'); };

  return (
    <div>
      <div className="toolbar">
        <Segmented value={type} onChange={(v) => { setType(v); setPage(1); }} options={[
          { value: 'truck', label: 'Trucks' }, { value: 'trailer', label: 'Trailers' },
        ]} />
        <div className="search-inline"><span className="ico">🔍</span><input placeholder="Search unit, VIN, plate…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search equipment" /></div>
        <button className="btn" onClick={refresh}>Refresh</button>
        <div className="spacer" />
        <button className="btn" onClick={() => setImporting(true)}>Import</button>
        <button className="btn primary" onClick={() => toast('Create equipment — not implemented in this build')}>+ Create</button>
      </div>

      <Card pad={false}>
        {q.meta && q.meta.stale && <div className="stale-banner" style={{ margin: 12 }}>Showing cached data.</div>}
        {q.loading ? <Skeleton rows={6} /> : q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : rows.length === 0 ? (
          <EmptyState title={dq ? `No ${type}s match “${dq}”` : `No ${type}s found`} hint="Try a different search or import equipment." />
        ) : (
          <>
            <div className="tbl-wrap">
              <table className="tbl">
                <thead><tr>
                  <th>Unit / VIN</th>
                  <th>Make / Year</th>
                  <th>License Plate</th>
                  {type === 'truck' && <th>Fuel Type / Weight</th>}
                  <th>Operated by</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td className="stack"><div className="a">{r.unit_number}</div><div className="b">{r.vin || '—'}</div></td>
                      <td className="stack"><div className="a">{[r.make, r.model].filter(Boolean).join(' ') || '—'}</div><div className="b">{r.year || ''}</div></td>
                      <td>{r.license_plate || '—'}</td>
                      {type === 'truck' && <td className="stack"><div className="a">{r.fuel_type || '—'}</div><div className="b">{r.registered_weight ? `${r.registered_weight} lb` : ''}</div></td>}
                      <td>{r.operated_by || '—'}</td>
                      <td>
                        <StatusTag status={r.status} />
                        {r.conflict && <span className="tag amber" title="Imported/provider state disagrees with assignment" style={{ marginLeft: 6 }}>Conflict</span>}
                      </td>
                      <td><button className="btn sm" onClick={() => toast(`View ${r.unit_number} — not implemented`)}>View</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={q.data.page} pageSize={q.data.pageSize} total={q.data.total} onPage={setPage} />
          </>
        )}
      </Card>

      {importing && (
        <Modal title="Import Equipment" onClose={() => setImporting(false)} footer={<button className="btn" onClick={() => setImporting(false)}>Close</button>}>
          <p style={{ color: 'var(--text-2)' }}>Equipment import runs against the connected ELD/provider feed. This is a stub in the current build.</p>
        </Modal>
      )}
    </div>
  );
}
