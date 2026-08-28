export function sendRpcPrompt(child, id, message, onError) {
  let reported = false;
  const report = (cause) => {
    if (reported) return;
    reported = true;
    onError(cause instanceof Error ? cause : new Error(String(cause)));
  };
  child.stdin.once("error", report);

  if (!child.stdin.writable || child.stdin.destroyed) {
    child.stdin.off("error", report);
    report(new Error("pi stdin is not writable"));
    return;
  }

  try {
    child.stdin.write(`${JSON.stringify({ id, type: "prompt", message })}\n`, (error) => {
      if (error) report(error);
      else child.stdin.off("error", report);
    });
  } catch (cause) {
    child.stdin.off("error", report);
    report(cause);
  }
}
