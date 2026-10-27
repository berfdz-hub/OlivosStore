import { escapeHTML as H } from "./safe.js";
import {
  eventLabels,
  teamLabels,
  periodLabels,
  activityName,
  validateGroups,
} from "./event-groups.js";

const presets = {
  puebla: {
    label: "Club Puebla",
    type: "futbol",
    teamMode: "club_puebla",
    team: "Club Puebla",
    games: 1,
  },
  academy: {
    label: "Academia de fútbol",
    type: "futbol",
    teamMode: "academy",
    team: "",
    games: 1,
  },
  baseball: {
    label: "Béisbol",
    type: "beisbol",
    teamMode: "none",
    team: "",
    games: 1,
  },
  training: {
    label: "Entrenamiento",
    type: "entrenamiento",
    teamMode: "none",
    team: "",
    games: 0,
  },
  other: {
    label: "Otra actividad",
    type: "otro",
    teamMode: "none",
    team: "",
    games: null,
  },
};
const presetFor = (g) =>
  Object.entries(presets).find(
    ([key, p]) =>
      key !== "other" &&
      p.type === g.type &&
      p.teamMode === g.teamMode &&
      p.team === g.team,
  )?.[0] || "other";
const options = (items, value) =>
  Object.entries(items)
    .map(
      ([v, label]) =>
        `<option value="${H(v)}" ${v === value ? "selected" : ""}>${H(label)}</option>`,
    )
    .join("");

// Shared by planning, capture and audited corrections. Existing recorded ends are
// retained only while their corresponding start stays unchanged; no end is asked.
export function initActivityEditor({
  root = document,
  id,
  groups = [],
  onChange = () => {},
}) {
  const host = root.getElementById(id);
  let rows = structuredClone(groups);
  const el = (i, key) => root.getElementById(`${id}-${i}-${key}`);
  const field = (i, key, label, control) =>
    `<div class="field"><label for="${id}-${i}-${key}">${H(label)}</label>${control}</div>`;
  const select = (i, key, label, items, value) =>
    field(
      i,
      key,
      label,
      `<select id="${id}-${i}-${key}">${options(items, value)}</select>`,
    );
  function read() {
    return rows.map((old, i) => {
      const teamMode = el(i, "teamMode").value;
      const games =
        el(i, "games").value === "" ? null : Number(el(i, "games").value);
      return {
        type: el(i, "type").value,
        games,
        teamMode,
        team:
          teamMode === "club_puebla"
            ? "Club Puebla"
            : teamMode === "named"
              ? el(i, "team").value.trim()
              : "",
        ...(el(i, "period").value !== "unknown" || old.period != null
          ? { period: el(i, "period").value }
          : {}),
        slots:
          games == null
            ? []
            : [...el(i, "slots").querySelectorAll("[data-start]")].map(
                (input, j) => ({
                  start: input.value,
                  end:
                    old.slots?.[j]?.start === input.value
                      ? old.slots[j].end || ""
                      : "",
                }),
              ),
      };
    });
  }
  function sync(i) {
    el(i, "teamField").hidden = el(i, "teamMode").value !== "named";
    const value = el(i, "games").value;
    const count =
      value === "" ? 0 : Math.min(50, Math.max(1, Number(value) || 0));
    const slots = el(i, "slots");
    el(i, "hours").hidden = !count;
    if (slots.querySelectorAll("[data-start]").length !== count) {
      const previous = [...slots.querySelectorAll("[data-start]")].map(
        (input) => input.value,
      );
      slots.innerHTML = Array.from({ length: count }, (_, j) =>
        field(
          i,
          `start${j}`,
          `${Number(value) === 0 ? "Inicio" : "Inicio del partido " + (j + 1)} · actividad ${i + 1}`,
          `<input type="time" data-start id="${id}-${i}-start${j}" value="${H(previous[j] ?? rows[i].slots?.[j]?.start ?? "")}">`,
        ),
      ).join("");
    }
    const current = {
      type: el(i, "type").value,
      teamMode: el(i, "teamMode").value,
      team: el(i, "team").value.trim(),
    };
    el(i, "title").textContent = activityName(current);
  }
  function render() {
    host.innerHTML =
      `<div class="activity-shortcuts" aria-label="Agregar actividad">${Object.entries(
        presets,
      )
        .map(
          ([key, p]) =>
            `<button type="button" class="btn sec sm" data-add-activity="${key}" ${rows.length >= 12 ? "disabled" : ""}>+ ${H(p.label)}</button>`,
        )
        .join("")}</div>` +
      (rows.length
        ? ""
        : '<p class="activity-empty">Elige lo que habrá ese día. Puedes agregar varias actividades.</p>') +
      rows
        .map((g, i) => {
          const preset = presetFor(g);
          return `<fieldset class="activity-card"><legend id="${id}-${i}-title">${H(activityName(g))}</legend><div class="activity-card-heading">${select(i, "preset", `Actividad ${i + 1}`, Object.fromEntries(Object.entries(presets).map(([k, p]) => [k, p.label])), preset)}<button class="btn sec sm" type="button" data-remove-activity="${i}" aria-label="Quitar ${H(activityName(g))}">Quitar</button></div>
          <details ${preset === "other" ? "open" : ""}><summary>Cambiar deporte o equipo</summary><div class="grid grid2">${select(i, "type", `Deporte o actividad · ${i + 1}`, eventLabels, g.type)}${select(i, "teamMode", `Equipo · actividad ${i + 1}`, teamLabels, g.teamMode)}</div><div id="${id}-${i}-teamField">${field(i, "team", `Nombre del equipo · actividad ${i + 1}`, `<input id="${id}-${i}-team" maxlength="120" value="${H(g.team)}">`)}</div></details>
          <div class="grid grid2">${field(i, "games", `Número de partidos · actividad ${i + 1}`, `<input type="number" inputmode="numeric" min="0" max="50" step="1" id="${id}-${i}-games" value="${g.games ?? ""}" placeholder="Por confirmar">`)}${select(i, "period", `Horario aproximado · actividad ${i + 1}`, periodLabels, g.period || "unknown")}</div>
          <p class="hint">Deja la cantidad en blanco si no la sabes. Usa 0 para una actividad sin partidos.</p>
          <details id="${id}-${i}-hours"><summary>Agregar horas de inicio (opcional)</summary><div class="activity-starts" id="${id}-${i}-slots"></div><p class="hint">Solo necesitamos los inicios. El sistema estima las ventanas de consumo cuando el historial lo permite.</p></details></fieldset>`;
        })
        .join("");
    rows.forEach((_, i) => sync(i));
  }
  host.addEventListener("click", (e) => {
    const add = e.target.closest("[data-add-activity]");
    const remove = e.target.closest("[data-remove-activity]");
    if (!add && !remove) return;
    rows = read();
    if (add && rows.length < 12) {
      const { label, ...value } = presets[add.dataset.addActivity];
      rows.push({ ...value, period: "unknown", slots: [] });
    }
    if (remove) rows.splice(Number(remove.dataset.removeActivity), 1);
    render();
    onChange();
  });
  for (const event of ["input", "change"])
    host.addEventListener(event, (e) => {
      const match = e.target.id.match(new RegExp(`^${id}-(\\d+)-(.+)$`));
      if (!match) return;
      const i = Number(match[1]),
        key = match[2];
      if (key === "preset" && event === "change") {
        rows = read();
        const { label, ...preset } = presets[e.target.value];
        rows[i] = {
          ...rows[i],
          ...preset,
          games: preset.games === 0 ? 0 : rows[i].games,
          slots: rows[i].slots,
        };
        render();
      } else sync(i);
      onChange();
    });
  render();
  return {
    read,
    set(value) {
      rows = structuredClone(value);
      render();
    },
    validate() {
      return validateGroups(read());
    },
  };
}
