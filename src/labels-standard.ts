export type StandardLabel = {
  name: string;
  color: string;
  description: string;
};

export const STANDARD_LABELS: StandardLabel[] = [
  { name: "bug",         color: "d73a4a", description: "Something isn't working" },
  { name: "feature",     color: "0e8a16", description: "New capability not previously present" },
  { name: "enhancement", color: "a2eeef", description: "Improvement to an existing capability" },
  { name: "docs",        color: "0075ca", description: "Documentation changes" },
  { name: "question",    color: "d876e3", description: "Further information is requested" },
  { name: "needs-info",  color: "fbca04", description: "Reporter needs to provide more detail" },
  { name: "duplicate",   color: "cfd3d7", description: "This issue or pull request already exists" },
  { name: "p0",          color: "b60205", description: "Priority: drop everything" },
  { name: "p1",          color: "d93f0b", description: "Priority: high" },
  { name: "p2",          color: "fbca04", description: "Priority: medium" },
  { name: "p3",          color: "c5def5", description: "Priority: low" },
  { name: "agent:assigned", color: "fbca04", description: "Agent is currently working this issue" },
];

export const STANDARD_LABEL_NAMES: string[] = STANDARD_LABELS.map(l => l.name);
