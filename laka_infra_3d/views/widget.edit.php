<?php declare(strict_types = 0);
/*
 * LAKA Infra 3D – gemelo digital de data center para Zabbix 7.0 – 8.0
 * © LAKA Soluciones Tecnológicas
 * Autor: Willian Tola
 * Licencia GPLv3
 *
 * Vista del formulario de configuración.
 *
 * @var CView $this
 * @var array $data
 */

use Modules\LakaInfra3D\Includes\{
	I18n,
	WidgetForm
};

$t = [I18n::class, 't'];

$form = new CWidgetFormView($data);

$groupids_field = array_key_exists('groupids', $data['fields'])
	? new CWidgetFieldMultiSelectGroupView($data['fields']['groupids'])
	: null;

$hostids_field = array_key_exists('hostids', $data['fields'])
	? (new CWidgetFieldMultiSelectHostView($data['fields']['hostids']))
		->setFilterPreselect([
			'id' => $groupids_field->getId(),
			'accept' => CMultiSelect::FILTER_PRESELECT_ACCEPT_ID,
			'submit_as' => 'groupid'
		])
	: null;

$tag_fields = [];

foreach (array_keys(WidgetForm::DEFAULT_TAGS) as $name) {
	$tag_fields[] = (new CWidgetFieldTextBoxView($data['fields'][$name]))->setWidth(ZBX_TEXTAREA_SMALL_WIDTH);
}

$form
	->addField($groupids_field)
	->addField($hostids_field)
	->addField(new CWidgetFieldMultiSelectOverrideHostView($data['fields']['override_hostid']))
	->addField(new CWidgetFieldSelectView($data['fields']['lang']))
	->addField(
		(new CWidgetFieldTextBoxView($data['fields']['room']))
			->setPlaceholder($t('Todas'))
			->setWidth(ZBX_TEXTAREA_SMALL_WIDTH)
	)
	->addField(new CWidgetFieldSelectView($data['fields']['layout']))
	->addField(new CWidgetFieldSelectView($data['fields']['aisle']))
	->addField(new CWidgetFieldIntegerBoxView($data['fields']['rack_units']))
	->addField(new CWidgetFieldIntegerBoxView($data['fields']['racks_per_row']))
	->addField(new CWidgetFieldSelectView($data['fields']['view_mode']))
	->addField(new CWidgetFieldSelectView($data['fields']['color_style']))
	->addField(new CWidgetFieldCheckBoxView($data['fields']['show_labels']))
	->addField(new CWidgetFieldCheckBoxView($data['fields']['auto_rotate']))
	->addFieldset(
		new CWidgetFormFieldsetCollapsibleView($t('Datos de Zabbix'), [
			(new CWidgetFieldTextBoxView($data['fields']['temp_key']))->setWidth(ZBX_TEXTAREA_STANDARD_WIDTH),
			(new CWidgetFieldTextBoxView($data['fields']['cpu_key']))->setWidth(ZBX_TEXTAREA_STANDARD_WIDTH),
			(new CWidgetFieldTextBoxView($data['fields']['mem_key']))->setWidth(ZBX_TEXTAREA_STANDARD_WIDTH),
			(new CWidgetFieldTextBoxView($data['fields']['hum_key']))->setWidth(ZBX_TEXTAREA_STANDARD_WIDTH),
			(new CWidgetFieldTextBoxView($data['fields']['power_key']))->setWidth(ZBX_TEXTAREA_STANDARD_WIDTH),
			new CWidgetFieldCheckBoxView($data['fields']['show_suppressed'])
		])
	)
	->addFieldset(
		new CWidgetFormFieldsetCollapsibleView($t('Modo NOC'), [
			new CWidgetFieldCheckBoxView($data['fields']['noc_autostart']),
			new CWidgetFieldIntegerBoxView($data['fields']['noc_cycle']),
			new CWidgetFieldSelectView($data['fields']['noc_min_sev']),
			new CWidgetFieldCheckBoxView($data['fields']['noc_sound'])
		])
	)
	->addFieldset(
		new CWidgetFormFieldsetCollapsibleView($t('Tags de ubicación'), $tag_fields)
	)
	->addFieldset(
		new CWidgetFormFieldsetCollapsibleView($t('Distribución avanzada'), [
			(new CWidgetFieldTextAreaView($data['fields']['racks_def']))->setWidth(ZBX_TEXTAREA_STANDARD_WIDTH),
			(new CWidgetFieldTextAreaView($data['fields']['passives']))->setWidth(ZBX_TEXTAREA_STANDARD_WIDTH)
		])
	)
	->addItem(
		(new CDiv([
			new CTag('strong', true, $t('Racks:')),
			' ', $t('nombre;U;fila;posición — ej. R05;24;B;3'),
			new CTag('br'),
			new CTag('strong', true, $t('Pasivos:')),
			' ', $t('rack;U;alto;tipo;nombre — ej. R01;41;1;patch;pp-01'),
			new CTag('br'),
			$t('Tipos: servidor, red, storage, ups, pdu, patch, otro'),
			new CTag('br'),
			$t('Para armar la sala de forma visual, usa el botón "Editar sala" del widget.')
		]))->addClass(ZBX_STYLE_GREY)
	)
	->show();
