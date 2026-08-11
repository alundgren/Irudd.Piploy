/**
 * Decides whether an Application name is already taken. Matching is exact:
 * `Name` is validated as `[A-Za-z0-9_-]+` and compared case-sensitively
 * everywhere else (directories, image names), so two names differing only in
 * case are two Applications.
 */
export function isDuplicateApplicationName(
  applications: { Name: string }[],
  name: string,
): boolean {
  return applications.some((application) => application.Name === name);
}
