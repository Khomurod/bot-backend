import React, { useEffect, useRef, useState } from "react";
import { TrophyIcon } from "../RaceIcons";
import { mountCarScene, supportsWebGL } from "./carScene";
import { CELEBRATION_MS, MESSAGE } from "./celebrationTime";
import "./celebration.css";

/**
 * The 4 PM celebration: the leader's name over a real 3D car, for twelve
 * seconds. Without WebGL, or if the car fails to load, the same words with a
 * trophy — the celebration never depends on the 3D. `onCar`, when given, hears
 * which it was ("on" or "off"): the sound test reports it.
 */
export default function CelebrationOverlay({ winner, view, onCar }) {
  const canvas = useRef(null);
  const [car, setCar] = useState(() => (supportsWebGL() ? "loading" : "off"));

  useEffect(() => {
    if (car === "off") return undefined;
    let scene = null;
    let gone = false;
    mountCarScene(canvas.current, { durationMs: CELEBRATION_MS })
      .then((mounted) => {
        if (gone) mounted.dispose();
        else { scene = mounted; setCar("on"); }
      })
      .catch(() => { if (!gone) setCar("off"); });
    return () => {
      gone = true;
      if (scene) scene.dispose();
    };
    // Mounted once per celebration; `car` only moves forward from here.
  }, []);

  useEffect(() => {
    if (car !== "loading" && onCar) onCar(car);
  }, [car, onCar]);

  return (
    <div className="gr-celebration" role="dialog" aria-label="Today's leader">
      <canvas ref={canvas} className={`gr-celebration-car${car === "on" ? " is-on" : ""}`} aria-hidden="true" />
      {car === "off" && <span className="gr-celebration-trophy"><TrophyIcon size="1em" strokeWidth={1.4} /></span>}
      <div className="gr-celebration-top">
        <div className="gr-celebration-kicker">4:00 PM · 1st place{view === "teams" ? " team" : ""}</div>
        <div className="gr-celebration-name">{winner.name}</div>
      </div>
      <div className="gr-celebration-bottom">
        <p className="gr-celebration-message">{MESSAGE}</p>
        {car === "on" && (
          <div className="gr-celebration-credit">
            3D model: “Chevrolet Malibu Premier 2022” by Type_S, CC BY 4.0, modified
          </div>
        )}
      </div>
    </div>
  );
}
