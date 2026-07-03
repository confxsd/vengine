import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { useLibrary } from "../libraryStore";
import { lastSystemCharacter } from "../studio/lastVisited";

/**
 * The nav rail's `/system` entry: resolves to a concrete character's System page
 * — the last one visited if it still exists, else the first library character —
 * or to the Library when there are no characters to open yet.
 */
export default function SystemRedirect() {
  const navigate = useNavigate();
  const loaded = useLibrary((s) => s.loaded);
  const characters = useLibrary((s) => s.library.characters);

  useEffect(() => {
    if (!loaded) return;
    const remembered = lastSystemCharacter();
    const target = characters.find((c) => c.id === remembered) ?? characters[0];
    navigate(target ? `/system/${target.id}` : "/library", { replace: true });
  }, [loaded, characters, navigate]);

  return (
    <div className="flex h-full items-center justify-center text-faint">
      <Loader2 className="h-5 w-5 animate-spin" />
    </div>
  );
}
