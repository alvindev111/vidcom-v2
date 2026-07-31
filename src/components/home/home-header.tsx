import { ModeToggle } from "@/components/mode-toggle";

export function HomeHeader({ projectCount }: { projectCount: number }) {
  return (
    <header className="flex items-center gap-3 pb-6">
      <div>
        <h1 className="font-heading text-2xl font-semibold tracking-tight">
          Projects
        </h1>
        <p className="text-muted-foreground text-sm">
          {projectCount} compositions · click one to open the composer
        </p>
      </div>
      <div className="ml-auto">
        <ModeToggle />
      </div>
    </header>
  );
}
