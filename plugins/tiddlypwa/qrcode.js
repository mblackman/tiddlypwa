/*\
title: $:/plugins/mblackman/tiddlypwa/qrcode.js
type: application/javascript
module-type: library

Licensed under 0BSD, see license.tid.
Formatted with `deno fmt`.
\*/
(function () {
	'use strict';

	// Lightweight, zero-dependency QR code generator supporting Byte mode (ISO/IEC 18004)
	// Adapted for offline PWA environments.

	const QRMode = { MODE_8BIT_BYTE: 1 << 2 };
	const QRErrorCorrectLevel = { L: 1, M: 0, Q: 3, H: 2 };

	const QRMaskPattern = {
		PATTERN000: 0,
		PATTERN001: 1,
		PATTERN010: 2,
		PATTERN011: 3,
		PATTERN100: 4,
		PATTERN101: 5,
		PATTERN110: 6,
		PATTERN111: 7,
	};

	const QRMath = {
		glog: function (n) {
			if (n < 1) throw new Error('glog(' + n + ')');
			return QRMath.LOG_TABLE[n];
		},
		gexp: function (n) {
			while (n < 0) n += 255;
			while (n >= 256) n -= 255;
			return QRMath.EXP_TABLE[n];
		},
		EXP_TABLE: new Array(256),
		LOG_TABLE: new Array(256),
	};

	for (let i = 0; i < 8; i++) QRMath.EXP_TABLE[i] = 1 << i;
	for (let i = 8; i < 256; i++) {
		QRMath.EXP_TABLE[i] = QRMath.EXP_TABLE[i - 4] ^ QRMath.EXP_TABLE[i - 5] ^ QRMath.EXP_TABLE[i - 6] ^
			QRMath.EXP_TABLE[i - 8];
	}
	for (let i = 0; i < 255; i++) QRMath.LOG_TABLE[QRMath.EXP_TABLE[i]] = i;

	function QRPolynomial(num, shift) {
		if (num.length === undefined) throw new Error(num.length + '/' + shift);
		let offset = 0;
		while (offset < num.length && num[offset] === 0) offset++;
		this.num = new Array(num.length - offset + shift);
		for (let i = 0; i < num.length - offset; i++) this.num[i] = num[i + offset];
	}

	QRPolynomial.prototype = {
		get: function (index) {
			return this.num[index];
		},
		getLength: function () {
			return this.num.length;
		},
		multiply: function (e) {
			const num = new Array(this.getLength() + e.getLength() - 1);
			for (let i = 0; i < this.getLength(); i++) {
				for (let j = 0; j < e.getLength(); j++) {
					num[i + j] ^= QRMath.gexp(QRMath.glog(this.get(i)) + QRMath.glog(e.get(j)));
				}
			}
			return new QRPolynomial(num, 0);
		},
		mod: function (e) {
			if (this.getLength() - e.getLength() < 0) return this;
			const ratio = QRMath.glog(this.get(0)) - QRMath.glog(e.get(0));
			const num = new Array(this.getLength());
			for (let i = 0; i < this.getLength(); i++) num[i] = this.get(i);
			for (let i = 0; i < e.getLength(); i++) {
				num[i] ^= QRMath.gexp(QRMath.glog(e.get(i)) + ratio);
			}
			return new QRPolynomial(num, 0).mod(e);
		},
	};

	const QRRSBlock = {
		RS_BLOCK_TABLE: [
			// 1
			[1, 26, 19],
			[1, 26, 16],
			[1, 26, 13],
			[1, 26, 9],
			// 2
			[1, 44, 34],
			[1, 44, 28],
			[1, 44, 22],
			[1, 44, 16],
			// 3
			[1, 70, 55],
			[1, 70, 44],
			[2, 35, 17],
			[2, 35, 13],
			// 4
			[1, 100, 80],
			[2, 50, 32],
			[2, 50, 24],
			[4, 25, 9],
			// 5
			[1, 134, 108],
			[2, 67, 43],
			[2, 33, 15, 2, 34, 16],
			[2, 33, 11, 2, 34, 12],
			// 6
			[2, 86, 68],
			[4, 43, 27],
			[4, 43, 19],
			[4, 43, 15],
			// 7
			[2, 98, 78],
			[4, 49, 31],
			[2, 32, 14, 4, 33, 15],
			[4, 39, 13, 1, 40, 14],
			// 8
			[2, 121, 97],
			[2, 60, 38, 2, 61, 39],
			[4, 40, 18, 2, 41, 19],
			[4, 40, 14, 2, 41, 15],
			// 9
			[2, 146, 116],
			[3, 58, 36, 2, 59, 37],
			[4, 36, 16, 4, 37, 17],
			[4, 36, 12, 4, 37, 13],
			// 10
			[2, 86, 68, 2, 87, 69],
			[4, 69, 43, 1, 70, 44],
			[6, 43, 19, 2, 44, 20],
			[6, 43, 15, 2, 44, 16],
			// 11
			[4, 101, 81],
			[1, 80, 50, 4, 81, 51],
			[4, 50, 22, 4, 51, 23],
			[3, 36, 12, 8, 37, 13],
			// 12
			[2, 116, 92, 2, 117, 93],
			[6, 58, 36, 2, 59, 37],
			[4, 46, 20, 6, 47, 21],
			[7, 42, 14, 4, 43, 15],
			// 13
			[4, 133, 107],
			[8, 59, 37, 1, 60, 38],
			[8, 44, 20, 4, 45, 21],
			[12, 33, 11, 4, 34, 12],
			// 14
			[3, 145, 115, 1, 146, 116],
			[4, 64, 40, 5, 65, 41],
			[11, 36, 16, 5, 37, 17],
			[11, 36, 12, 5, 37, 13],
		],
		getRSBlocks: function (typeNumber, errorCorrectLevel) {
			const rsBlock = QRRSBlock.getRsBlockTable(typeNumber, errorCorrectLevel);
			if (!rsBlock) {
				throw new Error('bad rs block @ typeNumber:' + typeNumber + '/errorCorrectLevel:' + errorCorrectLevel);
			}
			const length = rsBlock.length / 3;
			const list = [];
			for (let i = 0; i < length; i++) {
				const count = rsBlock[i * 3 + 0];
				const totalCount = rsBlock[i * 3 + 1];
				const dataCount = rsBlock[i * 3 + 2];
				for (let j = 0; j < count; j++) {
					list.push({ totalCount, dataCount });
				}
			}
			return list;
		},
		getRsBlockTable: function (typeNumber, errorCorrectLevel) {
			switch (errorCorrectLevel) {
				case QRErrorCorrectLevel.L:
					return QRRSBlock.RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 0];
				case QRErrorCorrectLevel.M:
					return QRRSBlock.RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 1];
				case QRErrorCorrectLevel.Q:
					return QRRSBlock.RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 2];
				case QRErrorCorrectLevel.H:
					return QRRSBlock.RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 3];
				default:
					return undefined;
			}
		},
	};

	function QRBitBuffer() {
		this.buffer = [];
		this.length = 0;
	}

	QRBitBuffer.prototype = {
		get: function (index) {
			const bufIndex = Math.floor(index / 8);
			return ((this.buffer[bufIndex] >>> (7 - index % 8)) & 1) === 1;
		},
		put: function (num, length) {
			for (let i = 0; i < length; i++) {
				this.putBit(((num >>> (length - i - 1)) & 1) === 1);
			}
		},
		getLengthInBits: function () {
			return this.length;
		},
		putBit: function (bit) {
			const bufIndex = Math.floor(this.length / 8);
			if (this.buffer.length <= bufIndex) this.buffer.push(0);
			if (bit) this.buffer[bufIndex] |= 0x80 >>> (this.length % 8);
			this.length++;
		},
	};

	const QRUtil = {
		PATTERN_POSITION_TABLE: [
			[],
			[6, 18],
			[6, 22],
			[6, 26],
			[6, 30],
			[6, 34],
			[6, 22, 38],
			[6, 24, 42],
			[6, 26, 46],
			[6, 28, 50],
			[6, 30, 54],
			[6, 32, 58],
			[6, 34, 62],
			[6, 26, 46, 66],
		],
		G15: (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | (1 << 0),
		G18: (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | (1 << 0),
		G15_MASK: (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1),
		getBCHTypeInfo: function (data) {
			let d = data << 10;
			while (QRUtil.getBCHDigit(d) - QRUtil.getBCHDigit(QRUtil.G15) >= 0) {
				d ^= QRUtil.G15 << (QRUtil.getBCHDigit(d) - QRUtil.getBCHDigit(QRUtil.G15));
			}
			return ((data << 10) | d) ^ QRUtil.G15_MASK;
		},
		getBCHDigit: function (data) {
			let digit = 0;
			while (data !== 0) {
				digit++;
				data >>>= 1;
			}
			return digit;
		},
		getPatternPosition: function (typeNumber) {
			return QRUtil.PATTERN_POSITION_TABLE[typeNumber - 1];
		},
		getMask: function (maskPattern, i, j) {
			switch (maskPattern) {
				case QRMaskPattern.PATTERN000:
					return (i + j) % 2 === 0;
				case QRMaskPattern.PATTERN001:
					return i % 2 === 0;
				case QRMaskPattern.PATTERN010:
					return j % 3 === 0;
				case QRMaskPattern.PATTERN011:
					return (i + j) % 3 === 0;
				case QRMaskPattern.PATTERN100:
					return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0;
				case QRMaskPattern.PATTERN101:
					return (i * j) % 2 + (i * j) % 3 === 0;
				case QRMaskPattern.PATTERN110:
					return ((i * j) % 2 + (i * j) % 3) % 2 === 0;
				case QRMaskPattern.PATTERN111:
					return ((i * j) % 3 + (i + j) % 2) % 2 === 0;
				default:
					throw new Error('bad maskPattern:' + maskPattern);
			}
		},
		getErrorCorrectPolynomial: function (errorCorrectLength) {
			let a = new QRPolynomial([1], 0);
			for (let i = 0; i < errorCorrectLength; i++) {
				a = a.multiply(new QRPolynomial([1, QRMath.gexp(i)], 0));
			}
			return a;
		},
		getLengthInBits: function (mode, type) {
			if (1 <= type && type < 10) {
				return 8;
			} else if (type < 27) {
				return 16;
			} else {
				return 16;
			}
		},
	};

	function QRCode(typeNumber, errorCorrectLevel) {
		this.typeNumber = typeNumber;
		this.errorCorrectLevel = errorCorrectLevel;
		this.modules = null;
		this.moduleCount = 0;
		this.dataCache = null;
		this.dataList = [];
	}

	QRCode.prototype = {
		addData: function (data) {
			const utf8Bytes = [];
			for (let i = 0; i < data.length; i++) {
				let charcode = data.charCodeAt(i);
				if (charcode < 0x80) utf8Bytes.push(charcode);
				else if (charcode < 0x800) {
					utf8Bytes.push(0xc0 | (charcode >> 6), 0x80 | (charcode & 0x3f));
				} else if (charcode < 0xd800 || charcode >= 0xe000) {
					utf8Bytes.push(0xe0 | (charcode >> 12), 0x80 | ((charcode >> 6) & 0x3f), 0x80 | (charcode & 0x3f));
				} else {
					i++;
					charcode = 0x10000 + (((charcode & 0x3ff) << 10) | (data.charCodeAt(i) & 0x3ff));
					utf8Bytes.push(
						0xf0 | (charcode >> 18),
						0x80 | ((charcode >> 12) & 0x3f),
						0x80 | ((charcode >> 6) & 0x3f),
						0x80 | (charcode & 0x3f),
					);
				}
			}
			this.dataList.push({
				mode: QRMode.MODE_8BIT_BYTE,
				data: utf8Bytes,
				getLength: function () {
					return utf8Bytes.length;
				},
				write: function (buffer) {
					for (let i = 0; i < utf8Bytes.length; i++) buffer.put(utf8Bytes[i], 8);
				},
			});
			this.dataCache = null;
		},
		isDark: function (row, col) {
			if (row < 0 || this.moduleCount <= row || col < 0 || this.moduleCount <= col) {
				throw new Error(row + ',' + col);
			}
			return this.modules[row][col];
		},
		getModuleCount: function () {
			return this.moduleCount;
		},
		make: function () {
			if (this.typeNumber < 1) {
				let typeNumber = 1;
				for (; typeNumber < 14; typeNumber++) {
					const rsBlocks = QRRSBlock.getRSBlocks(typeNumber, this.errorCorrectLevel);
					let totalDataCount = 0;
					for (let i = 0; i < rsBlocks.length; i++) totalDataCount += rsBlocks[i].dataCount;
					const lengthInBits = QRUtil.getLengthInBits(QRMode.MODE_8BIT_BYTE, typeNumber);
					const requiredBits = 4 + lengthInBits + (this.dataList[0].getLength() * 8) + 4;
					if (requiredBits <= totalDataCount * 8) break;
				}
				this.typeNumber = typeNumber;
			}
			this.makeImpl(false, this.getBestMaskPattern());
		},
		makeImpl: function (test, maskPattern) {
			this.moduleCount = this.typeNumber * 4 + 17;
			this.modules = new Array(this.moduleCount);
			for (let row = 0; row < this.moduleCount; row++) {
				this.modules[row] = new Array(this.moduleCount);
				for (let col = 0; col < this.moduleCount; col++) this.modules[row][col] = null;
			}
			this.setupPositionProbePattern(0, 0);
			this.setupPositionProbePattern(this.moduleCount - 7, 0);
			this.setupPositionProbePattern(0, this.moduleCount - 7);
			this.setupPositionAdjustPattern();
			this.setupTimingPattern();
			this.setupTypeInfo(test, maskPattern);
			if (this.dataCache === null) {
				this.dataCache = QRCode.createData(this.typeNumber, this.errorCorrectLevel, this.dataList);
			}
			this.mapData(this.dataCache, maskPattern);
		},
		setupPositionProbePattern: function (row, col) {
			for (let r = -1; r <= 7; r++) {
				if (row + r <= -1 || this.moduleCount <= row + r) continue;
				for (let c = -1; c <= 7; c++) {
					if (col + c <= -1 || this.moduleCount <= col + c) continue;
					if (
						(0 <= r && r <= 6 && (c === 0 || c === 6)) ||
						(0 <= c && c <= 6 && (r === 0 || r === 6)) ||
						(2 <= r && r <= 4 && 2 <= c && c <= 4)
					) {
						this.modules[row + r][col + c] = true;
					} else {
						this.modules[row + r][col + c] = false;
					}
				}
			}
		},
		getBestMaskPattern: function () {
			let minLostPoint = 0;
			let pattern = 0;
			for (let i = 0; i < 8; i++) {
				this.makeImpl(true, i);
				const lostPoint = QRUtil.getLostPoint(this);
				if (i === 0 || minLostPoint > lostPoint) {
					minLostPoint = lostPoint;
					pattern = i;
				}
			}
			return pattern;
		},
		setupTimingPattern: function () {
			for (let r = 8; r < this.moduleCount - 8; r++) {
				if (this.modules[r][6] !== null) continue;
				this.modules[r][6] = r % 2 === 0;
			}
			for (let c = 8; c < this.moduleCount - 8; c++) {
				if (this.modules[6][c] !== null) continue;
				this.modules[6][c] = c % 2 === 0;
			}
		},
		setupPositionAdjustPattern: function () {
			const pos = QRUtil.getPatternPosition(this.typeNumber);
			for (let i = 0; i < pos.length; i++) {
				for (let j = 0; j < pos.length; j++) {
					const row = pos[i];
					const col = pos[j];
					if (this.modules[row][col] !== null) continue;
					for (let r = -2; r <= 2; r++) {
						for (let c = -2; c <= 2; c++) {
							if (r === -2 || r === 2 || c === -2 || c === 2 || (r === 0 && c === 0)) {
								this.modules[row + r][col + c] = true;
							} else {
								this.modules[row + r][col + c] = false;
							}
						}
					}
				}
			}
		},
		setupTypeInfo: function (test, maskPattern) {
			const data = (this.errorCorrectLevel << 3) | maskPattern;
			const bits = QRUtil.getBCHTypeInfo(data);
			for (let i = 0; i < 15; i++) {
				const mod = !test && ((bits >> i) & 1) === 1;
				if (i < 6) this.modules[i][8] = mod;
				else if (i < 8) this.modules[i + 1][8] = mod;
				else this.modules[this.moduleCount - 15 + i][8] = mod;
			}
			for (let i = 0; i < 15; i++) {
				const mod = !test && ((bits >> i) & 1) === 1;
				if (i < 8) this.modules[8][this.moduleCount - i - 1] = mod;
				else if (i < 9) this.modules[8][15 - i - 1 + 1] = mod;
				else this.modules[8][15 - i - 1] = mod;
			}
			this.modules[this.moduleCount - 8][8] = !test;
		},
		mapData: function (data, maskPattern) {
			let inc = -1;
			let row = this.moduleCount - 1;
			let bitIndex = 7;
			let byteIndex = 0;
			for (let col = this.moduleCount - 1; col > 0; col -= 2) {
				if (col === 6) col--;
				while (true) {
					for (let c = 0; c < 2; c++) {
						if (this.modules[row][col - c] === null) {
							let dark = false;
							if (byteIndex < data.length) dark = ((data[byteIndex] >>> bitIndex) & 1) === 1;
							const mask = QRUtil.getMask(maskPattern, row, col - c);
							if (mask) dark = !dark;
							this.modules[row][col - c] = dark;
							bitIndex--;
							if (bitIndex === -1) {
								byteIndex++;
								bitIndex = 7;
							}
						}
					}
					row += inc;
					if (row < 0 || this.moduleCount <= row) {
						row -= inc;
						inc = -inc;
						break;
					}
				}
			}
		},
	};

	QRCode.createData = function (typeNumber, errorCorrectLevel, dataList) {
		const rsBlocks = QRRSBlock.getRSBlocks(typeNumber, errorCorrectLevel);
		const buffer = new QRBitBuffer();
		for (let i = 0; i < dataList.length; i++) {
			const data = dataList[i];
			buffer.put(data.mode, 4);
			buffer.put(data.getLength(), QRUtil.getLengthInBits(data.mode, typeNumber));
			data.write(buffer);
		}
		let totalDataCount = 0;
		for (let i = 0; i < rsBlocks.length; i++) totalDataCount += rsBlocks[i].dataCount;
		if (buffer.getLengthInBits() > totalDataCount * 8) {
			throw new Error('code length overflow. (' + buffer.getLengthInBits() + '>' + totalDataCount * 8 + ')');
		}
		if (buffer.getLengthInBits() + 4 <= totalDataCount * 8) buffer.put(0, 4);
		while (buffer.getLengthInBits() % 8 !== 0) buffer.putBit(false);
		while (true) {
			if (buffer.getLengthInBits() >= totalDataCount * 8) break;
			buffer.put(0xec, 8);
			if (buffer.getLengthInBits() >= totalDataCount * 8) break;
			buffer.put(0x11, 8);
		}
		return QRCode.createBytes(buffer, rsBlocks);
	};

	QRCode.createBytes = function (buffer, rsBlocks) {
		let offset = 0;
		let maxDcCount = 0;
		let maxEcCount = 0;
		const dcdata = new Array(rsBlocks.length);
		const ecdata = new Array(rsBlocks.length);
		for (let r = 0; r < rsBlocks.length; r++) {
			const dcCount = rsBlocks[r].dataCount;
			const ecCount = rsBlocks[r].totalCount - dcCount;
			maxDcCount = Math.max(maxDcCount, dcCount);
			maxEcCount = Math.max(maxEcCount, ecCount);
			dcdata[r] = new Array(dcCount);
			for (let i = 0; i < dcdata[r].length; i++) dcdata[r][i] = 0xff & buffer.buffer[i + offset];
			offset += dcCount;
			const rsPoly = QRUtil.getErrorCorrectPolynomial(ecCount);
			const rawPoly = new QRPolynomial(dcdata[r], rsPoly.getLength() - 1);
			const modPoly = rawPoly.mod(rsPoly);
			ecdata[r] = new Array(rsPoly.getLength() - 1);
			for (let i = 0; i < ecdata[r].length; i++) {
				const modIndex = i + modPoly.getLength() - ecdata[r].length;
				ecdata[r][i] = modIndex >= 0 ? modPoly.get(modIndex) : 0;
			}
		}
		let totalCodeCount = 0;
		for (let i = 0; i < rsBlocks.length; i++) totalCodeCount += rsBlocks[i].totalCount;
		const data = new Array(totalCodeCount);
		let index = 0;
		for (let i = 0; i < maxDcCount; i++) {
			for (let r = 0; r < rsBlocks.length; r++) {
				if (i < dcdata[r].length) data[index++] = dcdata[r][i];
			}
		}
		for (let i = 0; i < maxEcCount; i++) {
			for (let r = 0; r < rsBlocks.length; r++) {
				if (i < ecdata[r].length) data[index++] = ecdata[r][i];
			}
		}
		return data;
	};

	QRUtil.getLostPoint = function (qrCode) {
		const moduleCount = qrCode.getModuleCount();
		let lostPoint = 0;
		for (let row = 0; row < moduleCount; row++) {
			for (let col = 0; col < moduleCount; col++) {
				let sameCount = 0;
				const dark = qrCode.isDark(row, col);
				for (let r = -1; r <= 1; r++) {
					if (row + r < 0 || moduleCount <= row + r) continue;
					for (let c = -1; c <= 1; c++) {
						if (col + c < 0 || moduleCount <= col + c) continue;
						if (r === 0 && c === 0) continue;
						if (dark === qrCode.isDark(row + r, col + c)) sameCount++;
					}
				}
				if (sameCount > 5) lostPoint += 3 + sameCount - 5;
			}
		}
		for (let row = 0; row < moduleCount - 1; row++) {
			for (let col = 0; col < moduleCount - 1; col++) {
				let count = 0;
				if (qrCode.isDark(row, col)) count++;
				if (qrCode.isDark(row + 1, col)) count++;
				if (qrCode.isDark(row, col + 1)) count++;
				if (qrCode.isDark(row + 1, col + 1)) count++;
				if (count === 0 || count === 4) lostPoint += 3;
			}
		}
		return lostPoint;
	};

	/**
	 * Generates a clean SVG string of a QR Code for any text string.
	 * @param {string} text - Content to encode
	 * @param {object} [options]
	 * @param {number} [options.margin=4] - Quiet zone border width in modules
	 * @param {string} [options.ecLevel='M'] - Error correction level ('L', 'M', 'Q', 'H')
	 * @returns {string} SVG markup string
	 */
	function generateQRCodeSvg(text, options = {}) {
		const margin = options.margin !== undefined ? options.margin : 4;
		const ecLevelStr = options.ecLevel || 'M';
		const ecLevel = QRErrorCorrectLevel[ecLevelStr] !== undefined
			? QRErrorCorrectLevel[ecLevelStr]
			: QRErrorCorrectLevel.M;

		const qr = new QRCode(0, ecLevel);
		qr.addData(text);
		qr.make();

		const count = qr.getModuleCount();
		const totalSize = count + margin * 2;

		let pathD = '';
		for (let r = 0; r < count; r++) {
			for (let c = 0; c < count; c++) {
				if (qr.isDark(r, c)) {
					const x = c + margin;
					const y = r + margin;
					pathD += `M${x},${y}h1v1h-1z `;
				}
			}
		}

		return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalSize} ${totalSize}" shape-rendering="crispEdges" style="max-width: 100%; height: auto; display: block; margin: 0 auto; background: #ffffff;">` +
			`<rect width="${totalSize}" height="${totalSize}" fill="#ffffff"/>` +
			`<path d="${pathD}" fill="#000000"/>` +
			`</svg>`;
	}

	module.exports = {
		generateQRCodeSvg,
		QRCode,
		QRErrorCorrectLevel,
	};
})();
