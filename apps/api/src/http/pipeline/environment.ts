/* The process environment, or a fixture of it. Each variable is read by its literal name, so the configuration registry sees every one. */
export type Environment = Readonly<Record<string, string | undefined>>;
