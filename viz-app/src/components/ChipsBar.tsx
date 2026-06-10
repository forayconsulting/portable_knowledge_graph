import { useSignal } from "@preact/signals";
import type { VizController } from "../controller";
import type { Meta } from "../types";

function Chip({
	label,
	count,
	color,
	hidden,
	onToggle,
}: {
	label: string;
	count: number;
	color?: string;
	hidden: boolean;
	onToggle: () => void;
}) {
	return (
		<button
			type="button"
			class={`chip ${hidden ? "chip-off" : ""}`}
			onClick={onToggle}
			title={hidden ? `Show ${label}` : `Hide ${label}`}
		>
			{color && <span class="dot" style={{ background: color }} />}
			{label}
			<span class="chip-count">{count.toLocaleString()}</span>
		</button>
	);
}

/**
 * Combined legend and filter: the colored type chips double as the legend.
 * Namespaces are shown only when the graph actually has more than one.
 */
export function ChipsBar({
	controller,
	meta,
}: {
	controller: VizController;
	meta: Meta;
}) {
	const expanded = useSignal(false);
	const types = Object.entries(meta.nodes_by_type);
	const namespaces = Object.entries(meta.nodes_by_namespace);
	const collapsedCount = 6;
	const visibleTypes = expanded.value ? types : types.slice(0, collapsedCount);

	return (
		<div class="chipsbar">
			<div class="chip-row">
				{visibleTypes.map(([type, count]) => (
					<Chip
						key={type}
						label={type}
						count={count}
						color={controller.colorForType(type)}
						hidden={controller.hiddenTypes.value.has(type)}
						onToggle={() => controller.toggleType(type)}
					/>
				))}
				{types.length > collapsedCount && (
					<button
						type="button"
						class="chip chip-more"
						onClick={() => {
							expanded.value = !expanded.value;
						}}
					>
						{expanded.value ? "less" : `+${types.length - collapsedCount} more`}
					</button>
				)}
			</div>
			{namespaces.length > 1 && (
				<div class="chip-row chip-row-ns">
					{namespaces.map(([ns, count]) => (
						<Chip
							key={ns}
							label={ns}
							count={count}
							hidden={controller.hiddenNamespaces.value.has(ns)}
							onToggle={() => controller.toggleNamespace(ns)}
						/>
					))}
				</div>
			)}
		</div>
	);
}
