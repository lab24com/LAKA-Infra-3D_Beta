<?php declare(strict_types = 0);
/*
 * LAKA Infra 3D – gemelo digital de data center para Zabbix 7.0 – 8.0
 * © LAKA Soluciones Tecnológicas
 * Autor: Willian Tola
 * Licencia GPLv3
 *
 * Formulario de configuración del widget.
 */

namespace Modules\LakaInfra3D\Includes;

use CSeverityHelper;

use Zabbix\Widgets\{
	CWidgetField,
	CWidgetForm
};

use Zabbix\Widgets\Fields\{
	CWidgetFieldCheckBox,
	CWidgetFieldIntegerBox,
	CWidgetFieldMultiSelectGroup,
	CWidgetFieldMultiSelectHost,
	CWidgetFieldMultiSelectOverrideHost,
	CWidgetFieldSelect,
	CWidgetFieldTextArea,
	CWidgetFieldTextBox
};

class WidgetForm extends CWidgetForm {

	// Disposición de las filas de racks.
	public const LAYOUT_FACING = 0;		// Filas enfrentadas de a dos, con pasillo frío entre ellas.
	public const LAYOUT_PARALLEL = 1;	// Todas las filas mirando hacia el mismo lado.
	public const LAYOUT_SINGLE = 2;		// Todos los racks en una sola fila.

	// Modo de color al abrir el widget.
	public const MODE_STATUS = 0;
	public const MODE_HEAT = 1;
	public const MODE_CAPACITY = 2;

	// Estilo de colores del widget.
	public const STYLE_ZABBIX = 0;		// Colores del frontend de Zabbix (por defecto).
	public const STYLE_VIVID = 1;		// Colores vivos, pensado para pantallas de NOC.

	// Valores por defecto de los nombres de tags.
	public const DEFAULT_TAGS = [
		'tag_rack' => 'rack',
		'tag_u' => 'u',
		'tag_size' => 'alto',
		'tag_face' => 'cara',
		'tag_row' => 'fila',
		'tag_type' => 'tipo',
		'tag_room' => 'sala'
	];

	public function addFields(): self {
		I18n::setLanguage((int) ($this->values['lang'] ?? I18n::LANG_AUTO));
		$t = [I18n::class, 't'];

		$this
			->addField($this->isTemplateDashboard()
				? null
				: new CWidgetFieldMultiSelectGroup('groupids', $t('Grupos de hosts'))
			)
			->addField($this->isTemplateDashboard()
				? null
				: new CWidgetFieldMultiSelectHost('hostids', $t('Hosts'))
			)
			->addField(
				new CWidgetFieldMultiSelectOverrideHost()
			)
			->addField(
				(new CWidgetFieldSelect('lang', $t('Idioma del widget'), [
					I18n::LANG_AUTO => $t('Automático (idioma del usuario)'),
					I18n::LANG_ES => 'Español',
					I18n::LANG_PT => 'Português (Brasil)',
					I18n::LANG_EN => 'English'
				]))->setDefault(I18n::LANG_AUTO)
			)
			->addField(
				(new CWidgetFieldTextBox('room', $t('Sala')))->setDefault('')
			)
			->addField(
				(new CWidgetFieldSelect('layout', $t('Disposición'), [
					self::LAYOUT_FACING => $t('Filas enfrentadas'),
					self::LAYOUT_PARALLEL => $t('Filas paralelas'),
					self::LAYOUT_SINGLE => $t('Una sola fila')
				]))->setDefault(self::LAYOUT_FACING)
			)
			->addField(
				(new CWidgetFieldSelect('aisle', $t('Pasillo central entre filas'), [
					0 => $t('Frío (frentes enfrentados)'),
					1 => $t('Caliente (espaldas enfrentadas)')
				]))->setDefault(0)
			)
			->addField(
				(new CWidgetFieldIntegerBox('rack_units', $t('U por rack'), 4, 60))
					->setDefault(42)
					->setFlags(CWidgetField::FLAG_NOT_EMPTY)
			)
			->addField(
				(new CWidgetFieldIntegerBox('racks_per_row', $t('Racks por fila'), 1, 60))
					->setDefault(10)
					->setFlags(CWidgetField::FLAG_NOT_EMPTY)
			)
			->addField(
				(new CWidgetFieldSelect('view_mode', $t('Vista inicial'), [
					self::MODE_STATUS => $t('Estado'),
					self::MODE_HEAT => $t('Mapa de calor'),
					self::MODE_CAPACITY => $t('Capacidad')
				]))->setDefault(self::MODE_STATUS)
			)
			// Estilo de colores: los del frontend de Zabbix o una paleta viva.
			// Los temas de alto contraste siempre usan sus propios colores, por accesibilidad.
			->addField(
				(new CWidgetFieldSelect('color_style', $t('Estilo de colores'), [
					self::STYLE_ZABBIX => $t('Zabbix (colores del frontend)'),
					self::STYLE_VIVID => $t('Vivo')
				]))->setDefault(self::STYLE_ZABBIX)
			)
			->addField(
				(new CWidgetFieldTextBox('temp_key', $t('Clave de ítem de temperatura')))->setDefault('*temp*')
			)
			->addField(
				(new CWidgetFieldTextBox('cpu_key', $t('Clave de ítem de CPU')))->setDefault('system.cpu.util*')
			)
			// Uso de memoria RAM: clave de las plantillas oficiales Linux y Windows por agente Zabbix (vm.memory.util)
			// y de muchas plantillas SNMP (vm.memory.util[...]).
			->addField(
				(new CWidgetFieldTextBox('mem_key', $t('Clave de ítem de memoria RAM')))->setDefault('vm.memory.util*')
			)
			->addField(
				(new CWidgetFieldTextBox('hum_key', $t('Clave de ítem de humedad')))->setDefault('*hum*')
			)
			->addField(
				(new CWidgetFieldTextBox('power_key', $t('Clave de ítem de potencia de las PDU')))->setDefault('*power*')
			)
			->addField(
				new CWidgetFieldCheckBox('show_suppressed', null, $t('Mostrar problemas suprimidos'))
			)
			->addField(
				(new CWidgetFieldCheckBox('show_labels', null, $t('Mostrar nombres de racks')))->setDefault(1)
			)
			->addField(
				new CWidgetFieldCheckBox('auto_rotate', null, $t('Giro automático al abrir'))
			)
			// Modo NOC: pantalla de sala de monitoreo con recorrido automático y alertas.
			->addField(
				(new CWidgetFieldCheckBox('noc_autostart', null, $t('Iniciar en modo NOC con el tablero en modo quiosco')))
					->setDefault(1)
			)
			->addField(
				(new CWidgetFieldIntegerBox('noc_cycle', $t('Segundos por paso del recorrido NOC'), 5, 120))
					->setDefault(12)
					->setFlags(CWidgetField::FLAG_NOT_EMPTY)
			)
			->addField(
				(new CWidgetFieldSelect('noc_min_sev', $t('Severidad mínima en modo NOC'), self::severityOptions()))
					->setDefault(TRIGGER_SEVERITY_WARNING)
			)
			->addField(
				new CWidgetFieldCheckBox('noc_sound', null, $t('Alerta sonora ante problemas nuevos'))
			);

		foreach (self::DEFAULT_TAGS as $name => $default) {
			$this->addField((new CWidgetFieldTextBox($name, $t(self::tagLabel($name))))->setDefault($default));
		}

		return $this
			->addField(
				(new CWidgetFieldTextArea('racks_def', $t('Racks (uno por línea)')))->setDefault('')
			)
			->addField(
				(new CWidgetFieldTextArea('passives', $t('Equipos pasivos (uno por línea)')))->setDefault('')
			);
	}

	/**
	 * Severidades con los nombres configurados en Zabbix (Administración → General → Opciones de triggers).
	 */
	public static function severityOptions(): array {
		$options = [];

		for ($severity = TRIGGER_SEVERITY_NOT_CLASSIFIED; $severity < TRIGGER_SEVERITY_COUNT; $severity++) {
			$options[$severity] = CSeverityHelper::getName($severity);
		}

		return $options;
	}

	public static function tagLabel(string $name): string {
		return [
			'tag_rack' => 'Tag de rack',
			'tag_u' => 'Tag de U inicial',
			'tag_size' => 'Tag de alto en U',
			'tag_face' => 'Tag de cara',
			'tag_row' => 'Tag de fila',
			'tag_type' => 'Tag de tipo',
			'tag_room' => 'Tag de sala'
		][$name];
	}
}
