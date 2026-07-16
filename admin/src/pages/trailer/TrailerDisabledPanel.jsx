import React from "react";
import { Card } from "./TrailerUi";

/**
 * One panel, shown instead of mounting a department page — otherwise every
 * child page fires its own request and stacks a "disabled" error on top of an
 * empty state.
 */
export default function TrailerDisabledPanel({ isSuperAdmin }) {
  return (
    <Card className="trailer-disabled-panel">
      <h2>Trailer Department is turned off</h2>
      {isSuperAdmin ? (
        <>
          <p>
            The server is running with <code>TRAILER_DEPARTMENT_ENABLED=false</code>,
            which is the emergency kill switch for the department APIs.
          </p>
          <p>
            To turn it back on, set <code>TRAILER_DEPARTMENT_ENABLED=true</code> in the
            server environment or remove the variable entirely — it is enabled by
            default when unset. The change takes effect only after the server is
            restarted or redeployed.
          </p>
        </>
      ) : (
        <p>
          Contact an administrator to enable the Trailer Department for this server.
        </p>
      )}
    </Card>
  );
}
