// 预设模块入口（占位）：后续接入到预设页面
export async function mount(ctx){
  try{
    const html = await ctx.renderExtensionTemplateAsync('third-party/ST-Diff/modules/presets','panel');
    const $el = $(html).hide();
    $('body').append($el);
  }catch(e){ console.warn('[ST-Diff][presets] mount failed', e); }
}

