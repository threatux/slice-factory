// Audio timestamps only (no playback): consumed by the render script and exported as .events.json for ASMR mixing.
export function createEventLog(events) {
  return { all: () => events.map(({ time, type, round, tool, intensity }) => ({ time: +time.toFixed(4), type, round, tool, intensity: +intensity.toFixed(3) })) };
}
