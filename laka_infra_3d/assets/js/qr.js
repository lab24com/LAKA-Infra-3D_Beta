/*
 * LAKA Infra 3D – gemelo digital de data center para Zabbix 7.0 – 8.0
 * © LAKA Soluciones Tecnológicas
 * Autor: Willian Tola
 * Licencia GPLv3
 *
 * Generador de códigos QR (ISO/IEC 18004) propio, sin librerías ni servicios externos: el widget funciona en
 * redes sin salida a Internet. Modo byte (UTF-8), corrección de errores nivel M (15 %), versiones 1 a 15
 * (hasta 412 bytes, de sobra para un enlace de Zabbix) y elección automática de la máscara.
 */

class LakaInfra3DQR {

	// Nivel M: [total de codewords, codewords de corrección por bloque, bloques del grupo 1, datos por bloque
	// del grupo 1, bloques del grupo 2, datos por bloque del grupo 2]. Versiones 1 a 15.
	static BLOCKS_M = [null,
		[26, 10, 1, 16, 0, 0], [44, 16, 1, 28, 0, 0], [70, 26, 1, 44, 0, 0], [100, 18, 2, 32, 0, 0],
		[134, 24, 2, 43, 0, 0], [172, 16, 4, 27, 0, 0], [196, 18, 4, 31, 0, 0], [242, 22, 2, 38, 2, 39],
		[292, 22, 3, 36, 2, 37], [346, 26, 4, 43, 1, 44], [404, 30, 1, 50, 4, 51], [466, 22, 6, 36, 2, 37],
		[532, 22, 8, 37, 1, 38], [581, 24, 4, 40, 5, 41], [655, 24, 5, 41, 5, 42]
	];

	// Centros de los patrones de alineación por versión.
	static ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46],
		[6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70]];

	/**
	 * Matriz del código: array de filas con true (oscuro) / false (claro). null si el texto no entra.
	 */
	static matrix(text) {
		const bytes = Array.from(new TextEncoder().encode(String(text)));
		let version = 0;

		for (let v = 1; v <= 15; v++) {
			const b = LakaInfra3DQR.BLOCKS_M[v];
			const dataCw = b[2] * b[3] + b[4] * b[5];

			if (4 + (v < 10 ? 8 : 16) + bytes.length * 8 <= dataCw * 8) {
				version = v;
				break;
			}
		}

		if (!version) {
			return null;
		}

		const qr = new LakaInfra3DQR(version);

		qr.encode(bytes);

		return qr.modules;
	}

	/**
	 * SVG listo para insertar (con margen de 4 módulos, como pide la norma).
	 */
	static svg(text, size = 120) {
		const m = LakaInfra3DQR.matrix(text);

		if (!m) {
			return '';
		}

		const n = m.length + 8;
		let path = '';

		m.forEach((row, y) => row.forEach((dark, x) => {
			if (dark) {
				path += `M${x + 4} ${y + 4}h1v1h-1z`;
			}
		}));

		return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${size}" height="${size}" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
	}

	constructor(version) {
		this.version = version;
		this.size = version * 4 + 17;
		this.modules = Array.from({length: this.size}, () => Array(this.size).fill(false));
		this.fixed = Array.from({length: this.size}, () => Array(this.size).fill(false));
	}

	set(x, y, dark) {
		this.modules[y][x] = dark;
		this.fixed[y][x] = true;
	}

	// ---------------------------------------------------------------- patrones de función

	drawFunctionPatterns() {
		const s = this.size;

		// Patrones de tiempo.
		for (let i = 0; i < s; i++) {
			this.set(6, i, i % 2 === 0);
			this.set(i, 6, i % 2 === 0);
		}

		// Patrones de posición (con su separador) en tres esquinas.
		this.finder(3, 3);
		this.finder(s - 4, 3);
		this.finder(3, s - 4);

		// Patrones de alineación, salvo donde chocan con los de posición.
		const pos = LakaInfra3DQR.ALIGN[this.version];
		const last = pos.length - 1;

		pos.forEach((a, i) => pos.forEach((b, j) => {
			if (!((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0))) {
				this.alignment(a, b);
			}
		}));

		// Zonas reservadas para el formato (se escriben de verdad después de elegir la máscara).
		this.drawFormat(0);
		this.drawVersion();
	}

	finder(cx, cy) {
		for (let dy = -4; dy <= 4; dy++) {
			for (let dx = -4; dx <= 4; dx++) {
				const x = cx + dx;
				const y = cy + dy;
				const d = Math.max(Math.abs(dx), Math.abs(dy));

				if (x >= 0 && x < this.size && y >= 0 && y < this.size) {
					this.set(x, y, d !== 2 && d !== 4);
				}
			}
		}
	}

	alignment(cx, cy) {
		for (let dy = -2; dy <= 2; dy++) {
			for (let dx = -2; dx <= 2; dx++) {
				this.set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
			}
		}
	}

	drawFormat(mask) {
		// Nivel M = 00; BCH(15,5) con el polinomio 0x537 y la máscara 0x5412.
		const data = (0 << 3) | mask;
		let rem = data;

		for (let i = 0; i < 10; i++) {
			rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
		}

		const bits = ((data << 10) | rem) ^ 0x5412;
		const bit = (i) => ((bits >>> i) & 1) !== 0;
		const s = this.size;

		for (let i = 0; i <= 5; i++) {
			this.set(8, i, bit(i));
		}
		this.set(8, 7, bit(6));
		this.set(8, 8, bit(7));
		this.set(7, 8, bit(8));
		for (let i = 9; i < 15; i++) {
			this.set(14 - i, 8, bit(i));
		}
		for (let i = 0; i < 8; i++) {
			this.set(s - 1 - i, 8, bit(i));
		}
		for (let i = 8; i < 15; i++) {
			this.set(8, s - 15 + i, bit(i));
		}
		// Módulo siempre oscuro.
		this.set(8, s - 8, true);
	}

	drawVersion() {
		if (this.version < 7) {
			return;
		}

		let rem = this.version;

		for (let i = 0; i < 12; i++) {
			rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
		}

		const bits = (this.version << 12) | rem;

		for (let i = 0; i < 18; i++) {
			const dark = ((bits >>> i) & 1) !== 0;
			const a = this.size - 11 + i % 3;
			const b = Math.floor(i / 3);

			this.set(a, b, dark);
			this.set(b, a, dark);
		}
	}

	// ---------------------------------------------------------------- datos y corrección de errores

	encode(bytes) {
		const [, ecLen, g1, d1, g2, d2] = LakaInfra3DQR.BLOCKS_M[this.version];
		const dataCw = g1 * d1 + g2 * d2;
		const bits = [];
		const push = (value, len) => {
			for (let i = len - 1; i >= 0; i--) {
				bits.push((value >>> i) & 1);
			}
		};

		// Modo byte, cantidad de bytes, datos, terminador y relleno.
		push(0b0100, 4);
		push(bytes.length, this.version < 10 ? 8 : 16);
		bytes.forEach((b) => push(b, 8));
		push(0, Math.min(4, dataCw * 8 - bits.length));

		while (bits.length % 8) {
			bits.push(0);
		}

		const data = [];

		for (let i = 0; i < bits.length; i += 8) {
			data.push(bits.slice(i, i + 8).reduce((acc, b) => (acc << 1) | b, 0));
		}

		for (let pad = 0xEC; data.length < dataCw; pad ^= 0xEC ^ 0x11) {
			data.push(pad);
		}

		// Bloques con su corrección Reed-Solomon y entrelazado.
		const divisor = LakaInfra3DQR.rsDivisor(ecLen);
		const blocks = [];
		let k = 0;

		for (let b = 0; b < g1 + g2; b++) {
			const len = b < g1 ? d1 : d2;
			const dat = data.slice(k, k + len);

			k += len;
			blocks.push({dat, ec: LakaInfra3DQR.rsRemainder(dat, divisor)});
		}

		const out = [];

		for (let i = 0; i < Math.max(d1, d2); i++) {
			blocks.forEach((b) => {
				if (i < b.dat.length) {
					out.push(b.dat[i]);
				}
			});
		}

		for (let i = 0; i < ecLen; i++) {
			blocks.forEach((b) => out.push(b.ec[i]));
		}

		this.drawFunctionPatterns();
		this.drawCodewords(out);

		// Máscara con menor penalización.
		let best = 0;
		let bestScore = Infinity;

		for (let mask = 0; mask < 8; mask++) {
			this.applyMask(mask);
			this.drawFormat(mask);

			const score = this.penalty();

			if (score < bestScore) {
				bestScore = score;
				best = mask;
			}

			this.applyMask(mask);
		}

		this.applyMask(best);
		this.drawFormat(best);
	}

	drawCodewords(cw) {
		const s = this.size;
		let i = 0;

		for (let right = s - 1; right >= 1; right -= 2) {
			if (right === 6) {
				right = 5;
			}

			for (let vert = 0; vert < s; vert++) {
				for (let j = 0; j < 2; j++) {
					const x = right - j;
					const up = ((right + 1) & 2) === 0;
					const y = up ? s - 1 - vert : vert;

					if (!this.fixed[y][x] && i < cw.length * 8) {
						this.modules[y][x] = ((cw[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
						i++;
					}
				}
			}
		}
	}

	applyMask(mask) {
		const fns = [
			(x, y) => (x + y) % 2 === 0,
			(x, y) => y % 2 === 0,
			(x) => x % 3 === 0,
			(x, y) => (x + y) % 3 === 0,
			(x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
			(x, y) => (x * y) % 2 + (x * y) % 3 === 0,
			(x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0,
			(x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0
		];
		const fn = fns[mask];

		for (let y = 0; y < this.size; y++) {
			for (let x = 0; x < this.size; x++) {
				if (!this.fixed[y][x] && fn(x, y)) {
					this.modules[y][x] = !this.modules[y][x];
				}
			}
		}
	}

	penalty() {
		const s = this.size;
		const m = this.modules;
		let score = 0;
		let dark = 0;
		const line = (get) => {
			// Regla 1: corridas de 5 o más módulos iguales. Regla 3: patrones parecidos a los de posición.
			let run = 1;
			let str = '';

			for (let i = 0; i < s; i++) {
				const v = get(i);

				str += v ? '1' : '0';

				if (i > 0 && v === get(i - 1)) {
					run++;
				}
				else {
					if (run >= 5) {
						score += run - 2;
					}
					run = 1;
				}
			}

			if (run >= 5) {
				score += run - 2;
			}

			for (const p of ['10111010000', '00001011101']) {
				for (let i = str.indexOf(p); i !== -1; i = str.indexOf(p, i + 1)) {
					score += 40;
				}
			}
		};

		for (let y = 0; y < s; y++) {
			line((x) => m[y][x]);
		}
		for (let x = 0; x < s; x++) {
			line((y) => m[y][x]);
		}

		// Regla 2: bloques de 2×2 del mismo color. Regla 4: proporción de módulos oscuros.
		for (let y = 0; y < s; y++) {
			for (let x = 0; x < s; x++) {
				if (m[y][x]) {
					dark++;
				}

				if (x < s - 1 && y < s - 1 && m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) {
					score += 3;
				}
			}
		}

		return score + Math.floor(Math.abs(dark * 20 - s * s * 10) / (s * s)) * 10;
	}

	static mul(x, y) {
		let z = 0;

		for (let i = 7; i >= 0; i--) {
			z = (z << 1) ^ ((z >>> 7) * 0x11D);
			z ^= ((y >>> i) & 1) * x;
		}

		return z & 0xFF;
	}

	static rsDivisor(degree) {
		const result = Array(degree).fill(0);
		let root = 1;

		result[degree - 1] = 1;

		for (let i = 0; i < degree; i++) {
			for (let j = 0; j < degree; j++) {
				result[j] = LakaInfra3DQR.mul(result[j], root);

				if (j + 1 < degree) {
					result[j] ^= result[j + 1];
				}
			}
			root = LakaInfra3DQR.mul(root, 0x02);
		}

		return result;
	}

	static rsRemainder(data, divisor) {
		const result = divisor.map(() => 0);

		for (const b of data) {
			const factor = b ^ result.shift();

			result.push(0);
			divisor.forEach((coef, i) => {
				result[i] ^= LakaInfra3DQR.mul(coef, factor);
			});
		}

		return result;
	}
}
