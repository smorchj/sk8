# ramp-uv-bake.py — Blender, headless: bake each quarter-pipe variant's base
# colour into the UV layout of the ONE ramp mesh the game uses (variant 1).
# The seven Meshy exports share the same triangles, but Meshy unwrapped each
# one again, so a texture swapped onto the shared mesh only fits its own
# layout (owner, 2026-09-03: "they just share mesh vertex, not UV").
# "Selected to active" bakes colour from the variant mesh (selected) onto the
# base mesh (active); the two surfaces coincide, so every texel lands where
# it belongs, and the bake margin fills the seams.
#
# Usage:
#   blender -b --python tools/ramp-uv-bake.py -- <base.glb> <out_dir> <variant2.glb> [variant3.glb …]
# writes <out_dir>/v2.webp, v3.webp … (1024², quality 80 — the game's format)
import bpy, os, sys

argv = sys.argv[sys.argv.index('--') + 1:]
base_path, out_dir, variants = argv[0], argv[1], argv[2:]
BAKE_SIZE, OUT_SIZE = 2048, 1024


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_mesh(path):
    before = {o.name for o in bpy.data.objects}
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o.name not in before and o.type == 'MESH']
    if len(new) != 1:
        raise SystemExit(f'{path}: expected one mesh, got {len(new)}')
    return new[0]


for i, vpath in enumerate(variants):
    k = i + 2
    reset()
    scene = bpy.context.scene
    base = import_mesh(base_path)
    var = import_mesh(vpath)

    # the bake target: a fresh image on the base mesh's material, its node active
    img = bpy.data.images.new(f'bake_v{k}', BAKE_SIZE, BAKE_SIZE, alpha=False)
    mat = base.active_material
    if mat is None or not mat.use_nodes:
        raise SystemExit('the base mesh has no node material')
    nt = mat.node_tree
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = img
    for n in nt.nodes:
        n.select = False
    tex.select = True
    nt.nodes.active = tex

    # colour only (no light), from the variant onto the base
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = 8
    scene.cycles.bake_type = 'DIFFUSE'
    b = scene.render.bake
    b.use_pass_direct = False
    b.use_pass_indirect = False
    b.use_pass_color = True
    b.use_selected_to_active = True
    b.use_cage = False
    b.cage_extrusion = 0.01
    b.max_ray_distance = 0.02
    b.margin = 16
    b.target = 'IMAGE_TEXTURES'

    bpy.ops.object.select_all(action='DESELECT')
    var.select_set(True)
    base.select_set(True)
    bpy.context.view_layer.objects.active = base
    bpy.ops.object.bake(type='DIFFUSE')

    img.scale(OUT_SIZE, OUT_SIZE)
    scene.render.image_settings.file_format = 'WEBP'
    scene.render.image_settings.quality = 80
    scene.render.image_settings.color_mode = 'RGB'
    out = os.path.join(out_dir, f'v{k}.webp')
    img.save_render(out, scene=scene)
    print(f'[ramp-uv-bake] v{k} <- {os.path.basename(vpath)} -> {out} ({os.path.getsize(out) // 1024} KB)')
