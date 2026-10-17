// Today's calendar date as "YYYY-MM-DD" in the process's local timezone (the
// Pi's system TZ -- nothing in this fleet sets TZ per process). The digest's
// "as of" date, soleImminentItem's `today` and filterFutureEvents all want the
// local day, not the UTC slice, which reads as tomorrow on an evening run.
export function localDateString(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
