// Stub of the pi-tui components duker-loop renders with. render() returns plain lines.
export class Text {
	constructor(text = "", paddingX = 0, paddingY = 0) {
		this.text = text;
		this.paddingX = paddingX;
		this.paddingY = paddingY;
	}
	render() {
		return this.text.split("\n");
	}
	invalidate() {}
}

export class Container {
	constructor() {
		this.children = [];
	}
	addChild(c) {
		this.children.push(c);
	}
	render(width) {
		return this.children.flatMap((c) => c.render(width));
	}
	invalidate() {}
}
