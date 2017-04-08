import * as Core from "sinap-core";
import { TypescriptPlugin } from "./plugin";
import { Type, Value } from "sinap-types";
import { Model } from "sinap-core";
import { naturalToValue, valueToNatural } from "./natural";


export class TypescriptProgram implements Core.Program {
    private toNatural: (value: Value.Value) => any;
    private toValue: (value: any) => Value.Value;
    private stateType: any;
    readonly environment = new Value.Environment();
    readonly model: Model;

    constructor(modelIn: Model, public plugin: TypescriptPlugin) {
        this.model = Model.fromSerial(modelIn.serialize(), plugin);
        this.environment = this.model.environment;

        const nodes = new Value.ArrayObject(new Value.ArrayType(plugin.types.nodes), this.model.environment);
        const edges = new Value.ArrayObject(new Value.ArrayType(plugin.types.edges), this.model.environment);

        for (const node of this.model.nodes) {
            nodes.push(node);
            node.set("children", new Value.ArrayObject(node.type.members.get("children") as Value.ArrayType, this.environment));
            node.set("parents", new Value.ArrayObject(node.type.members.get("parents") as Value.ArrayType, this.environment));
        }

        for (const edge of this.model.edges) {
            edges.push(edge);
            const sourceBox = edge.get("source") as Value.Union;
            const source = sourceBox.value as Value.CustomObject;
            const sourceChildren = source.get("children") as Value.ArrayObject;
            sourceChildren.push(edge);

            const destinationBox = edge.get("destination") as Value.Union;
            const destination = destinationBox.value as Value.CustomObject;
            const destinationParents = destination.get("parents") as Value.ArrayObject;
            destinationParents.push(edge);
        }

        this.model.graph.set("nodes", nodes);
        this.model.graph.set("edges", edges);

        const rules: [Type.CustomObject, Function][] = [];
        const addRule = (t: Type.CustomObject) => {
            const nativeType = this.plugin.implementation[t.name];
            rules.push([t, nativeType]);
            return nativeType;
        };

        addRule(this.plugin.types.graph.pluginType);
        this.stateType = addRule(this.plugin.types.state);

        for (const nodeType of this.plugin.types.nodes.types) {
            addRule(nodeType.pluginType);
        }

        for (const edgeType of this.plugin.types.edges.types) {
            addRule(edgeType.pluginType);
        }

        this.toNatural = valueToNatural(new Map(rules));
        this.toValue = naturalToValue(this.environment,
            rules.map((([a, b]) => [b, a] as [Function, Type.CustomObject])));

    };

    run(a: Value.Value[]): { steps: Value.CustomObject[], result?: Value.Value, error?: Value.Primitive } {
        if (a.length !== this.plugin.types.arguments.length) {
            throw new Error("Program.run: incorrect arity");
        }
        a.forEach((v, i) => {
            if (!Type.isSubtype(v.type, this.plugin.types.arguments[i])) {
                throw new Error(`Program.run argument at index: ${i} is of incorrect type`);
            }
        });


        const unwrappedGraph = this.toNatural(this.model.graph);
        const unwrappedInputs = a.map(v => this.toNatural(v));

        let state: any;
        try {
            state = this.plugin.implementation.start(unwrappedGraph, ...unwrappedInputs);
        } catch (err) {
            return { steps: [], error: Value.makePrimitive(this.environment, err) };
        }
        const steps: Value.CustomObject[] = [];

        while (state instanceof this.stateType) {
            steps.push(this.toValue(state) as Value.CustomObject);
            try {
                state = this.plugin.implementation.step(state);
            } catch (err) {
                return { steps: steps, error: Value.makePrimitive(this.environment, err) };
            }
        }
        return { steps: steps, result: this.toValue(state) };
    }

    validate() {
        const unwrappedGraph = this.toNatural(this.model.graph);

        try {
            this.plugin.implementation.start(unwrappedGraph, "");
        } catch (err) {
            return Value.makePrimitive(this.environment, err);
        }
        return null;
    }
}
