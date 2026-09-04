import React from "react";
import PageFailure from "./PageFailure";

/**
 * Keeps one section's failure inside that section.
 *
 * WHAT WENT WRONG BEFORE. A single boundary instance wrapped every lazy page,
 * and `getDerivedStateFromError` latched its `failed` flag forever. So the
 * first section that threw — Driver Groups, on a missing import — left the
 * boundary in its failed state, and every section opened afterwards rendered
 * the same "Could not load this page" text without ever being mounted. One
 * broken page made the entire admin panel look broken, which is exactly what
 * production reported.
 *
 * Two things fix that, and both are needed:
 *
 *   - `resetKey`: when the selected page changes, the caught error is dropped
 *     and the new section is really rendered. (The App passes the page key, so
 *     navigation always clears a previous section's failure.)
 *   - `attempt`: "Try again" remounts the subtree instead of re-showing the
 *     same stale render, so a transient failure can genuinely recover.
 *
 * The wording and the offered action come from PageFailure, which classifies
 * the error rather than blaming a deploy for everything.
 */
export default class PageErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, where: "", resetKey: props.resetKey, attempt: 0 };
    this.retry = this.retry.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  /** Navigating to another section clears the previous section's failure. */
  static getDerivedStateFromProps(props, state) {
    if (props.resetKey !== state.resetKey) {
      return { error: null, where: "", resetKey: props.resetKey };
    }
    return null;
  }

  componentDidCatch(error, info) {
    const where = firstComponentFrame(info && info.componentStack);
    this.setState({ where });
    // Logged with the section name so a report from an admin ("Mileage Bonuses
    // is broken") can be matched to a stack without a reproduction.
    console.error(`[admin] section "${this.props.resetKey || "unknown"}" failed:`, error, where);
  }

  retry() {
    this.setState((state) => ({ error: null, where: "", attempt: state.attempt + 1 }));
  }

  render() {
    if (this.state.error) {
      return (
        <PageFailure error={this.state.error} where={this.state.where} onRetry={this.retry} />
      );
    }
    // The key remounts children after a retry; without it React reuses the
    // subtree it was about to unmount and the retry does nothing.
    return <React.Fragment key={this.state.attempt}>{this.props.children}</React.Fragment>;
  }
}

/** The first component frame of a React component stack, e.g. `in GroupsPage`. */
function firstComponentFrame(componentStack) {
  if (!componentStack) return "";
  const line = String(componentStack).split("\n").map((l) => l.trim()).filter(Boolean)[0];
  return line || "";
}
