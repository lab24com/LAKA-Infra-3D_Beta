<?php declare(strict_types = 0);
/*
 * LAKA Infra 3D – gemelo digital de data center para Zabbix 7.0 – 8.0
 * © LAKA Soluciones Tecnológicas
 * Autor: Willian Tola
 * Licencia GPLv3
 *
 * Traducciones del widget. La clave de cada texto es la versión en español;
 * Dictionary.php tiene su traducción a portugués (Brasil) e inglés.
 */

namespace Modules\LakaInfra3D\Includes;

use CWebUser;

class I18n {

	public const LANG_AUTO = 0;
	public const LANG_ES = 1;
	public const LANG_PT = 2;
	public const LANG_EN = 3;

	private static string $lang = 'es';

	/**
	 * Fija el idioma según el valor del campo "Idioma del widget".
	 * Automático usa el idioma del usuario de Zabbix; si no es español ni portugués, inglés.
	 */
	public static function setLanguage(int $choice): string {
		switch ($choice) {
			case self::LANG_ES:
				self::$lang = 'es';
				break;

			case self::LANG_PT:
				self::$lang = 'pt';
				break;

			case self::LANG_EN:
				self::$lang = 'en';
				break;

			default:
				$user_lang = strtolower((string) (CWebUser::$data['lang'] ?? 'en'));

				if (strpos($user_lang, 'es') === 0) {
					self::$lang = 'es';
				}
				elseif (strpos($user_lang, 'pt') === 0) {
					self::$lang = 'pt';
				}
				else {
					self::$lang = 'en';
				}
		}

		return self::$lang;
	}

	public static function getLanguage(): string {
		return self::$lang;
	}

	/**
	 * Traduce un texto. Si no está en el diccionario, se devuelve el texto en español.
	 */
	public static function t(string $text): string {
		if (self::$lang === 'es') {
			return $text;
		}

		$dictionary = Dictionary::get();

		if (array_key_exists($text, $dictionary)) {
			return $dictionary[$text][self::$lang === 'pt' ? 0 : 1];
		}

		return $text;
	}

	/**
	 * Diccionario completo para el JS en el idioma activo (clave en español → texto traducido).
	 */
	public static function forJs(): array {
		$result = [];

		foreach (Dictionary::get() as $es => $translations) {
			if (self::$lang === 'es') {
				$result[$es] = $es;
			}
			else {
				$result[$es] = $translations[self::$lang === 'pt' ? 0 : 1];
			}
		}

		return $result;
	}
}
